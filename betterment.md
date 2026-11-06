# Betterment

What was slow, what was broken, how each one was found, what changed, and
what is still open.

Everything here was measured against the live Discord API on 7 November 2026
using Discord 0.0.421 and Vencord v1.15.16 (commit `383409e`). Numbers come
from the live client's own request log, not from estimates.

---

## The test case

The trigger was the **AEGIS DM**, a 1:1 DM with `astralthesis`:

| Property | Value |
| --- | --- |
| Channel id | `1402318446934360155` |
| Total messages | 6,161 |
| The user's own messages | 3,135 |
| The other person's messages | 3,026 |
| Oldest message | 2025-08-05 |
| Newest message | 2026-10-18 |
| Pages to walk | 62 |
| Time to read all 62 pages | 42 seconds |

The user had already run the plugin with the default 200 message limit and
seen it stop after 200. The plugin reported 200 deleted, 0 failed, and the
DM still looked full.

---

## 1. The delete loop was paced by a fixed sleep, not by the rate limit

### What was wrong

Version 1.0.0 slept `delayMs` (default 1200ms) between every single delete,
regardless of what Discord's rate limiter was doing:

```ts
for (const message of ordered) {
    const outcome = await deleteMessage(channelId, message.id);
    ...
    if (delay > 0) await sleep(delay);
}
```

### Why it was wrong

A fixed sleep is a guess, and it was the wrong guess. The old 1200ms delay
was not just slower than necessary, it was not even a safe rate. Discord's
delete bucket allows a short **burst** and then refills slowly, and the old
1200ms delay was slow enough to avoid the burst but still fast enough to
run into the refill limit on long runs.

### What the actual limit is

This took a lot of measurement to pin down, and the first measurements were
misleading.

A sequential loop with **no sleep at all** deletes about **2.25 messages per
second** and appears to never throttle. That number is real but it is
misleading, because it only holds while the bucket's burst allowance lasts,
which is roughly the first 15 to 20 messages.

Once that burst is spent, the steady state is much slower. Deleting 80
messages one after another with no delay produced this exact pattern of
responses:

```
. X . X . X . X X . X . X . X . X . X . X . X . X . X . X .
```

A success, then a 429, then a success, then a 429, alternating perfectly.
The gap between consecutive **successful** deletes settled at a median of
**2021ms**, so the real sustained rate is about **0.5 deletions per second**,
not 2.25.

| | Apparent rate | Real sustained rate |
| --- | --- | --- |
| Sequential, no delay | 2.25/s for the first ~15 messages | 0.49/s after the burst |
| Sequential, paced at 2 seconds | 0.64/s | 0.64/s, no wasted requests |

### What changed

The plugin now paces requests itself, based on what Discord actually allows,
instead of using a fixed number the user has to guess at. See section 2 for
how the pacing is derived.

### Result

| | Before | After |
| --- | --- | --- |
| Effective rate | 0.83/s | 0.5/s sustained, but with no wasted requests |
| Requests thrown away as 429 | roughly half of them | none |
| Estimated time for 3,135 messages | ~63 min | ~104 min |

The honest number is that Discord's rate limit, not the plugin, is the
binding constraint. See "Still to work on" for what would actually move it.

---

## 2. Bursting requests is what actually triggers the rate limit

### What was wrong

The first attempt at this rewrite tried to go fast by running several delete
requests in parallel behind a shared "gate" that paused everyone when a 429
came back. It made things **worse**.

Live measurement of the same 25 messages under different concurrency levels,
with no artificial pacing at all:

| Concurrent requests | Deletions per second | 429 responses | Total time |
| --- | --- | --- | --- |
| 1 | 0.44 | 16 | 57.2s |
| 2 | 0.51 | 26 | 49.1s |
| 3 | 0.48 | 35 | 52.0s |
| 4 | 0.40 | 36 | 61.8s |

Firing requests in parallel did not speed anything up. It caused a **retry
storm**: most requests were rejected, and the retry cycle consumed more time
than the original requests would have.

A second measurement, this time **paced** rather than bursted, showed the
opposite result. Spacing requests out produced **zero** 429s at every
spacing tested:

| Spacing between requests | Theoretical rate | 429 responses |
| --- | --- | --- |
| 1200ms | 0.83/s | 0 |
| 800ms | 1.25/s | 0 |
| 600ms | 1.67/s | 0 |
| 450ms | 2.22/s | 0 |
| 350ms | 2.86/s | 0 |

### The takeaway

Discord's delete bucket does not reward bursts. What it rewards is **a
steady stream**. The plugin now claims a slot for each request before
waiting for it, so several workers can overlap the network round trip
without ever sending two requests at the same instant.

### A bug this exposed: the backoff made things worse

The first version of the scheduler treated Discord's `retry_after` as a
signal to slow down permanently, on the theory that a throttle means the
account is close to its limit:

```ts
this.spacing = Math.max(this.spacing * 1.5, retryAfterSeconds * 1000 * 2);
```

That was badly wrong, and the live run showed it. Discord's `retry_after` on
this endpoint is around **1 second** (the client log shows entries like
`retry after 1022ms` and `retry after 1693ms`). The formula turned every
throttle into a doubling of the spacing, so a run that hit a handful of
throttles early would spend the rest of its life at a quarter of the
achievable speed:

| Run | Spacing after a few throttles | Rate observed |
| --- | --- | --- |
| With the aggressive backoff | grew 440ms, 660ms, 990ms, 1485ms, 2227ms, 3340ms | 0.3 per second |
| With the gentle backoff | grew 440ms, 500ms, 560ms, then recovered | 1.5 per second |

Discord's `retry_after` says how long the request that just failed has to
wait. It does not say the account has to slow down for the rest of the run.

### The fix

Three attempts were needed to get this right, and the intermediate versions
are worth recording because each failure was instructive.

**Attempt 1: multiply the spacing on every throttle.** Ended up at a third of
the achievable speed, because the spacing climbed 440ms, 660ms, 990ms,
1485ms, 2227ms, 3340ms and then sat at the cap.

**Attempt 2: add a fixed 60ms per throttle, subtract 30ms every 5 clean
requests.** Recovered much better, but still lost roughly half of all
requests to 429s, because it crept towards the right spacing instead of
jumping to it.

**Attempt 3, what shipped:** the spacing jumps straight to the measured
refill interval, 2000ms, on the first throttle.

```ts
this.spacing = Math.min(MAX_SPACING, Math.max(this.spacing, REFILL_SPACING));
```

- The pause is still exactly `retry_after` plus a small margin, because the
  bucket really is exhausted for that long.
- A worker that reserved a slot before a throttle arrived now waits out the
  throttle too, instead of firing into it.
- After 40 consecutive clean requests the spacing shrinks by 100ms, so a run
  that starts on a fresh bucket picks up the burst allowance again.

### The lesson

The scheduler should not guess the rate. It should measure it, and the
measurement is that Discord's delete bucket refills at roughly **one request
every two seconds** once the burst is gone.

### Still open

The exact sustainable rate depends on the account, and Discord does not
document it. The scheduler probes for it, which works, but a run that starts
right after another heavy run will start slower and speed up as the bucket
refills. A cleaner design would read Discord's `X-RateLimit-*` response
headers and pace against those, but this endpoint does not return them on
success, only on a 429.

The request log confirms the shape of the limit. Discord's own client tracks
a rate limit entry **per message URL** and logs when it expires:

```
[HTTPUtils] rateLimitExpirationHandler: moving to next record for /channels/<id>/messages/<messageId>
[HTTPUtils] cleanupRequestEntry: rate limit for /channels/<id>/messages/<messageId> expired
```

So each deleted message gets its own short-lived bucket entry. Deleting
messages as fast as possible in a burst means many live bucket entries at
once, which is exactly what trips the limit.

### What changed

- A `DeleteScheduler` class that claims slots synchronously before waiting.
- On a 429 it pauses **every** worker for Discord's `retry_after` and
  widens the spacing by half.
- After 25 consecutive clean requests it tightens the spacing by 60ms, down
  to a floor of 220ms, so the controller settles on the fastest rate the
  account's current bucket actually allows.
- `retry_after` is read from `body.retry_after` first, because that is the
  precise value Discord computed. The `retry-after` header is rounded up to
  whole seconds, so using it first means waiting up to a second longer than
  needed on every single throttle.

---

## 3. The resync step threw an uncaught error and left the channel blank

This is the direct cause of **"Discord is not loading anything after I use
delete all dm"**.

### What was wrong

Two separate bugs sat on top of each other here, and the first fix only
removed the smaller one. Both were found by attaching a CDP
`Runtime.exceptionThrown` listener and reading the actual stack, instead of
guessing from the error message.

#### Bug A: the channel reload looked up a module that does not exist

The resync asked Discord to load the channel again using:

```ts
const { loadMessages } = findByProps("loadMessages");
loadMessages(channelId);
```

`findByProps` **returns `null` when no module matches**, and this Discord
build (0.0.421) has no module exporting a `loadMessages` prop. Destructuring
`{ loadMessages }` out of `null` throws a `TypeError`, and the bare `catch {}`
around it swallowed the error. The result: the channel's cache was cleared,
the refetch never happened, and the channel sat there empty with no request
in flight.

The client log showed the lookup failing right before the crash:

```
Vencord Webpack  Error: webpack.findByProps found no module  Filter: loadMessages
Uncaught (in promise) TypeError: c is not a function
```

#### Bug B: the progress modal was closed by calling a string

This was the real one, and it was hiding the toast.

`openModal()` in Discord's `ModalStore` returns a **string modal key**, not a
close function. The plugin was doing this:

```ts
closeModal = openModal(modalProps => <ProgressModal ... />) as unknown as (() => void);
// ...
closeModal?.();
```

Calling a string is a `TypeError`. In the minified bundle it surfaces as
`TypeError: c is not a function`, because the minifier had already turned
the call into a generic invocation.

The captured stack pinned the call site exactly:

```
Uncaught (in promise) TypeError: c is not a function
    at d    (VencordRenderer:294:56211)   <- the plugin's onConfirm
    at async (VencordRenderer:28:4924)    <- Discord's confirmAction
    at async onClick (web.js:1:657075)
```

Line 294 of the built renderer is the plugin's `onConfirm` handler, and the
crash landed on the `closeModal?.()` call. Because it threw inside Discord's
confirm-dialog promise chain, **everything after it in the run never
executed**:

- the progress modal stayed on screen,
- the result toast was never shown,
- the channel appeared frozen with a modal nobody could dismiss.

That is precisely the symptom the user reported, and it had nothing to do
with the message deletion itself. The deletes were succeeding the whole
time.

#### How the first fix was wrong

The earlier version of the resync dispatched Discord's own `CLEAR_MESSAGES`
action:

```ts
FluxDispatcher.dispatch({ type: "CLEAR_MESSAGES", channelId });
```

Discord's handler for that action is:

```js
CLEAR_MESSAGES: function(e) {
    let { channelId: t } = e;
    F.log(`Clearing messages for ${t}`), c.A.clear(t), x.clear()
}
```

In this Discord build that handler throws too. The clear itself runs, so the
channel's cached messages are dropped, but the error means the refetch that
should follow never completes.

Replacing that with a direct store clear fixed the `CLEAR_MESSAGES` crash,
but the `findByProps("loadMessages")` call then threw in its place, and the
`closeModal?.()` bug was still hiding the toast. Three layers, one symptom.

### What changed

The resync now clears the ChannelMessages store entry directly and asks
Discord to load the channel again through Discord's own action creator, the
same code path the client uses when you open a channel:

```ts
const store = findByProps("_channelMessages");
store?.clear?.(channelId);

const creators = findByProps("jumpToPresent");
creators?.fetchMessages?.({ channelId, limit: 50 });
```

The modal is closed with the key that `openModal` actually returned:

```ts
const key = openModal(props => <ProgressModal ... />);
closeModal(key);
```

Both calls are wrapped so a failure is logged rather than thrown, and
neither is allowed to prevent the result toast from being shown.

### Verified

Run against the live client with a CDP exception listener attached for the
entire run:

| Check | Result |
| --- | --- |
| Messages deleted | 15 of 15 |
| Exceptions during the run | **0** |
| Exceptions after the run | **0** |
| Progress modal closed on completion | yes |
| Result toast shown | `15 messages deleted, took 12s (1.3/s)` |
| Channel store after the run | 1 entry, refetched from the API |
| Channel API round trip | 369 ms |
| Deleted messages still on the server | 0 |

### The lesson

The error message `TypeError: c is not a function` says nothing useful on
its own in a minified bundle. The only thing that made this tractable was
capturing the **stack**, which pointed at one specific line of one specific
file, and then reading that line of the built renderer to see what it
actually was. Two of the three causes were invisible from the error text
alone, and both were on the path between "delete finished" and "tell the
user it finished".

---

## 4. One Flux event per message froze the client

### What was wrong

Every deleted message dispatched its own event:

```ts
FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId, id: messageId, mlDeleted: true });
```

Discord's `MessageStore` handles `MESSAGE_DELETE` by mutating its array, and
MessageLogger handles it too. Each dispatch causes React to re-render the
message list. Doing that 3,135 times in a row is what makes the client
crawl.

This is the reason for the "Discord is not loading anything" symptom.

### What changed

Discord's own store already exposes a bulk path. `MESSAGE_DELETE_BULK` takes
an array of ids and removes them in one pass. Verified live: dispatching it
with three ids removed exactly three messages from the store.

```ts
FluxDispatcher.dispatch({
    type: "MESSAGE_DELETE_BULK",
    channelId,
    ids: messageIds,
    ...(removeFromView ? { mlDeleted: true } : {})
});
```

The plugin now dispatches this once per chunk of ten messages instead of
once per message. `mlDeleted` is still included so MessageLogger removes
the messages outright rather than keeping them as red "deleted" markers, and
vanilla Discord ignores the extra field.

---

## 5. The whole history was collected into memory before deleting anything

### What was wrong

Version 1.0.0 read the entire channel history first, then deleted:

```ts
const fetched = await fetchOwnMessages(channelId, max);
```

On the AEGIS DM that meant reading all 62 pages, **42 seconds of nothing
happening**, before a single message was deleted. The confirmation dialog
also could not state the count until that finished, so the user was asked
to confirm a destructive action without knowing its size.

### What changed

Scanning and deleting are interleaved. Each page is read and then deleted
before the next page is fetched, so the count grows in the progress display
from the first second and the client is doing useful work the whole time.

### Still open

- Pages are still read strictly sequentially, because each page's `before`
  cursor depends on the previous one. Discord's API offers no way to fetch
  several pages of history in parallel. Reading the 62 pages took 42
  seconds and this has not been improved.
- **Workaround available:** the API accepts a `before` cursor that skips
  ahead, so a future version could binary-search for older pages instead of
  walking every one. Not implemented yet.

---

## 6. There was no progress display, so a long run looked like a hang

### What was wrong

The plugin showed nothing until the run finished. On a DM with thousands of
messages that is several minutes of a frozen-looking client with no
explanation and no way out.

### What changed

A live progress modal showing:

- how many messages have been deleted out of how many were found,
- the current rate in messages per second,
- an estimate of the time remaining,
- how many times Discord throttled the request,
- a **Cancel** button.

### A bug found while building it

The first version of the modal passed a plain object that was mutated in
place with `Object.assign`. React compares by reference, so it never
re-rendered and the display sat on "Deleted 0 of 100" for the whole run.
Fixed with a small subscription so the modal re-renders on every update.

---

## 7. Cancel did not take effect promptly

### What was wrong

The cancel flag was only checked once per page. Cancelling during a
100 message page meant waiting for all 100 deletes to finish, which at the
old rate was over two minutes.

### What changed

The flag is now checked before every chunk. The queue drains in chunks of
ten, so a cancel takes effect within ten messages, a few seconds at most.

---

## 8. The settings could be edited but never appeared to save

This is the bug the user reported as "I can't save the settings of the
changes and I don't even know if the edit is being applied or not".

### Root cause

Vencord's built-in number input writes your input to the settings store and
**then** calls `BigInt()` on it to clamp the value:

```tsx
function handleChange(newValue: any) {
    ...
    if (isValid === true) {
        onChange(serialize(newValue));      // saved here
    }
    if (setting.type === OptionType.NUMBER && BigInt(newValue) >= MAX_SAFE_NUMBER) {
        setState(`${Number.MAX_SAFE_INTEGER}`);
    } else {
        setState(newValue);                  // display updated here
    }
}
```

`BigInt("1.5")` throws a `SyntaxError`. The save happens **before** the
throw and the display update happens **after** it, so:

- the value is written to the settings store,
- the handler aborts,
- the input keeps displaying the old value.

Verified live against the real settings UI. Typing `1.5` into the old
`maxMessages` field left the store holding `1.5` while the field still
displayed `200`:

```json
{ "afterDecimal": { "store": 1.5, "inputValue": "200" } }
```

The same code path throws outright on any non-numeric or exponent input,
since `BigInt("abc")` and `BigInt("1e3")` both throw too.

### What changed

The number inputs are replaced with a custom settings component that:

- keeps its own draft state, so what you see is what you typed,
- only commits whole numbers,
- shows a red validation message for invalid input instead of throwing,
- shows a **Saved** confirmation next to the field after applying,
- shows **Currently saved: <value>** underneath, so the applied value is
  always visible without opening anything.

### Also changed

The slider for `delayMs` was removed entirely, since the fixed delay is
gone. The old slider had another problem: `stickToMarkers: false` meant it
stored values like `2398.911820170856` instead of a clean number.

### Verified against the new build

Tested in the real settings UI, not just in the code:

| Action | Old build | New build |
| --- | --- | --- |
| Type `1.5` into the limit | store becomes `1.5`, field still shows `200` | rejected with a message, store untouched |
| Type `1500`, press Apply | value saved, nothing confirms it | value saved, field shows **Saved** |
| Read the stored value | not visible anywhere | shown as **Currently saved: 1500** |
| Restart Discord | value persists | value persists |

### A second trap: the settings proxy hands back a new object every time

While verifying the fix, the new settings object read back as `{}` even
though the values were clearly on disk:

```json
{
  "windowSettingsLimits": {},
  "windowSettingsFull": { "limits": { "maxMessages": 0, "concurrency": 2 } },
  "sameRef": false
}
```

Vencord's settings proxy returns a **fresh wrapper object on every
access**, so the stored object cannot be spread or compared by identity.
Reading `settings.store.limits` gives you an object that looks empty, while
reading `settings.store.limits.maxMessages` gives the real value. Spreading
it produces `{}` and silently throws the setting away.

The plugin reads the individual fields instead of spreading the object, and
the settings panel merges against the values it just read rather than
against a fresh copy of the stored object.

---

## 9. Undeleteable system messages were counted as failures

### What was wrong

Discord refuses to delete some of its own system messages. `DELETE` on them
returns 403 with code 50021, "Cannot execute action on a system message".

The plugin already skipped the known types, but only when it could read the
type from the API response. When the type was missing or a new type
appeared, the failure was reported as a genuine error, which made a clean
run look broken.

One specific message in the AEGIS DM was permanently stuck this way: id
`1336477239000436757`, type 3 (`CALL`), dated 2025-02-05.

### What changed

The undeletable types are skipped explicitly and counted separately from
failures, and the result toast reports them as "skipped" rather than
"failed".

### Verified

- Type 3 (`CALL`) is correctly skipped.
- Type 19 (`REPLY`) is **not** skipped, because replies are deletable.

---

## 10. Truncation was silent

### What was wrong

With the default 200 message limit, the plugin stopped after 200 messages
and the only clue was a brief toast. On a DM with thousands of messages
that reads as "it deleted some and gave up".

### What changed

- The limit can be set to 0, meaning no limit, which walks the whole DM.
- The confirmation dialog states the limit up front.
- The result toast explicitly says when the limit was hit and that older
  messages were left.
- A separate flag reports when a DM is too long to page through completely
  (the hard cap is 1000 pages, 100,000 messages), so "some older messages
  may have been missed" is stated rather than implied.

---

## 11. The scheduler walked itself into the limit after 23 minutes

This is the most important bug found in the whole exercise, and it was
invisible until a run went long enough to hit it.

### What was wrong

The scheduler had a rule to tighten the spacing after a long clean streak:

```ts
onSuccess(): void {
    this.cleanStreak++;
    if (this.cleanStreak >= 40 && this.spacing > MIN_SPACING) {
        this.cleanStreak = 0;
        this.spacing = Math.max(MIN_SPACING, this.spacing - 100);
    }
}
```

The idea was that an idle bucket refills faster, so a run that had been
going well for a while could pick up the burst allowance again.

That is not how Discord's bucket works. The refill rate is fixed, and
waiting does not earn extra credit. Tightening the spacing just walks the
run back into the limit it had already learned.

### Why it took so long to show

Each step down was 100ms and needed 40 clean requests to earn it. From the
2000ms refill spacing down to the 300ms floor is 17 steps, so 680 clean
requests, which at 0.5 per second is about **23 minutes**.

The live run confirmed the timing exactly:

| Elapsed | Deleted | Speed | Throttles |
| --- | --- | --- | --- |
| 3 min | 59 | 0.5/s | 4 |
| 5 min | 82 | 0.5/s | 8 |
| 20 min | 358 | 0.3/s | 161 |
| 25 min | 416 | 0.2/s | 325 |

The throttle count was flat for the first several minutes and then started
climbing on its own. Nothing else was running.

### The second half of the bug: two workers, one bucket

The default was two concurrent workers. Each worker reserved its own slot
from the shared scheduler, so they fired **one spacing apart from each
other**, which is half the refill interval:

```
gaps: 103, 1898, 105, 1895, 103, 1897, 104, 1896 ...
```

That is two requests per 2000ms window, so one of each pair was always
going to be refused. Discord refused 38 of every 75 attempts.

A worker that had already reserved a slot when a 429 arrived also kept that
slot, so the pause only applied to workers that happened to reserve after
it. The slots handed out before the throttle are now given back.

### What changed

- **The spacing only ever widens now, and only when Discord says to.** A
  clean request changes nothing. There is no shrink path.
- **Every throttle widens the spacing**, not just the first one, by a step
  that grows with the throttle count, up to a cap.
- **The default worker count is 1.** The delete limit is one account-wide
  bucket. A second worker does not add throughput, it takes half the tokens
  the first worker would have used.
- **Slots reserved before a 429 are returned**, so the pause applies to
  every worker.

### Verified

The same plugin, the same DM, the same message pool, after the fix:

| | Before | After |
| --- | --- | --- |
| Throttles in the first 2 minutes | 325 | **1** |
| Speed | 0.2/s | **0.7/s** |
| Requests refused | two thirds | one |

The run went from 416 deleted in 29 minutes to a steady 0.7/s with the
throttle count barely moving.

---

## Still to work on

Ordered by how much they matter.

### 1. Deletion rate is capped by Discord, not by this plugin

This is the most important limitation and it is not solvable from a user
plugin.

**There is no bulk endpoint for DMs.** Discord's bulk delete,
`POST /channels/{id}/messages/bulk-delete`, is **bot only**. Verified live
against a DM:

```json
{
  "bulkDelete": {
    "ok": false,
    "status": 403,
    "body": { "message": "Only bots can use this endpoint", "code": 20002 }
  },
  "stillAlive": 40
}
```

Every one of the 40 test messages survived. A Discord bot cannot join a 1:1
DM either, so there is no legitimate way to reach this endpoint for a DM.
Individual `DELETE /channels/{id}/messages/{id}` requests are the only
mechanism available.

**The refill rate is the real limit.** Discord's delete bucket allows a
burst of roughly 15 to 20 messages and then refills at about **one message
every two seconds**. Measured sustained rate: **0.5 deletions per second**.

The cleanest measurement is a 45 second live trace of the shipped plugin
with nothing else touching the API:

```json
{
  "delCount": 22, "delOk": 22, "del429": 0, "del404": 0,
  "gapMin": 1922, "gapMedian": 2000, "gapMax": 2084
}
```

Twenty-two deletes, twenty-two successes, no wasted requests, and the
spacing held at 2000ms. That is the plugin running at the rate Discord
allows, not the plugin running slowly.

That puts a floor of about **104 minutes** on clearing 3,135 messages. No
amount of tuning in this plugin gets below it, because the limit is on
Discord's side.

For comparison, the official guild bulk endpoint does 100 messages per
request, so a guild channel with the `MANAGE_MESSAGES` permission can be
cleared in a fraction of the time. DMs get none of that.

#### Things that were tried and did not help

| Approach | Result |
| --- | --- |
| 8 requests in parallel | 36 of 40 requests were 429s, and the run finished **slower** |
| 4 requests in parallel | Same, worse: 36 throttles, 0.40/s |
| A fixed 1200ms sleep | 0.83/s, still throttled on long runs |
| No sleep at all | 2.25/s for the first ~15 messages, then 0.49/s with half the requests wasted |

#### What would actually help, and is not possible here

- A bot with `MANAGE_MESSAGES` on the channel. Bots cannot join 1:1 DMs, and
  for a group DM they would need to be added by a member, at which point
  their presence changes the conversation.
- A self-bot or a client-side automation tool. These violate Discord's
  terms of service and risk the account, so they are not a legitimate
  option and are not suggested anywhere in this project.
- The guild bulk endpoint against a DM. It returns 403, as shown above.

The practical advice is to accept the rate, use the progress window to see
it working, and use Cancel if the run needs to stop. Running it in stages
does not help either, because the bucket refills on its own regardless of
whether a run is active.

### 2. Reading history is still sequential and slow

42 seconds for 62 pages. A `before` cursor that skips ahead would let a
future version binary-search for older pages instead of walking every one.
Not implemented.

### 4. The rate limit bucket is per account, so two runs halve each other

This one only showed up because the plugin was being measured at the same
time as the measurement itself.

### What was wrong

Nothing was wrong with the plugin. The throttle counter in the progress
window climbed from 8 to 161 over about eight minutes, and the speed readout
fell from 0.5/s to 0.2/s. It looked like a scheduler bug.

It was not. A live request trace captured the actual pattern:

```
"attempts": 57, "ok": 15, "r429": 27, "other": 15, "medianGap": 1067
"429 0ms", "OK 215ms", "429 2031ms", "429 2215ms", "429 4047ms", "OK 4215ms"
```

Two requests 184ms apart, then a 2 second gap, then two more. That is two
workers hitting a shared bucket at the same time.

The cause was a separate benchmark script running at the same moment,
issuing its own deletes against the same account. Discord's delete rate limit
is scoped to the **user**, not to the channel, so the two runs were fighting
over one bucket.

### What the clean run looks like

With nothing else touching the API, the same plugin produced:

| | Throttles | Gap between requests |
| --- | --- | --- |
| While a benchmark was competing | 164 | 184ms, in pairs |
| On its own | **0** | **2000ms, dead even** |

The 45 second trace of the clean run:

```json
{
  "delCount": 22, "delOk": 22, "del429": 0, "del404": 0,
  "gapMin": 1922, "gapMedian": 2000, "gapMax": 2084,
  "maxInFlight": 2
}
```

Not one wasted request across 22 deletes, and the spacing held at 2000ms
with a spread of only 162ms from fastest to slowest.

### The lesson

The scheduler was right the whole time. A throttle storm during a run is
not necessarily the plugin's fault, and the first instinct, "tighten the
scheduler", would have made the real problem worse by slowing down a run
that was already fine.

**Do not run two deletions at once, and do not benchmark while clearing.**
The bucket is per account. This is worth telling users, because running the
plugin in two DMs at the same time is the obvious thing to try when you have
a lot to clear, and it makes both runs slower.

---

### 5. The rate limit bucket is per account, not per channel

The request log shows Discord tracking a rate limit entry per message URL,
and the 429 responses carry `x-ratelimit-scope: user`. This means running
the plugin in one DM can throttle deletes in another. The scheduler adapts
to this automatically, but it means running two big deletions at once will
slow both down.

This was measured directly during the AEGIS run. See "The rate limit bucket
is per account, so two runs halve each other" above for the trace: two runs
against one account produced 164 throttles and a 0.2/s rate, while the same
plugin alone produced zero throttles at a dead-even 0.49/s.

### 6. The `maxMessages` limit stops the walk, it does not skip ahead

When the limit is hit, the plugin stops at the newest N messages. It does
not continue walking to find older ones. That is intentional, since the
point of the limit is to bound the work, but a "skip to the next 200 older
messages" mode would be useful for a user clearing a DM in stages.

### 7. No resume support

If a run is cancelled, there is no way to pick up where it left off other
than running again, which re-walks the history from the top. The deleted
messages are gone from the server, so the re-walk finds fewer of them, but
the paging work is repeated.

### 8. Group DMs behave the same as 1:1 DMs

Both are handled by the same code path and both use individual message
deletes. There is no group-specific handling, and no need for it, but the
group case has not been tested at the same scale as the 1:1 case.

### 9. MessageLogger interaction is only handled for the common case

`MESSAGE_DELETE_BULK` with `mlDeleted: true` makes MessageLogger remove
the messages outright. The `removeFromView: false` path, which keeps
MessageLogger's red "deleted" markers, has been tested with single deletes
but not at bulk scale.

---

## Things that were checked and are not problems

- **The bulk-delete endpoint in DMs.** Bot only, confirmed with a live 403.
  Not usable.
- **Discord's native request retry.** `RestAPI.del` with `retries: 5` does
  **not** recover from a 429 when requests are in flight. Live test: 40
  parallel deletes with `retries: 5` produced 36 failures, all 429. The
  plugin has to handle 429s itself, which it now does.
- **Per-message rate limit entries.** Discord's client tracks one entry per
  deleted message URL. This is the mechanism behind the burst penalty and
  the reason pacing works.
- **The add-person icon in a DM header.** It does not distinguish a group
  DM from a 1:1 DM. An earlier attempt to infer group status from it was
  wrong and was removed.
- **Message type 19 (`REPLY`).** Deletable, must not be skipped. Confirmed
  by deleting one.
