# Changelog

All notable changes to BulkDeleteDm are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

## [2.2.0] - 2026-11-07

The long-run rate limit fix. This one only showed up on a run that went
past 23 minutes, which is exactly why every earlier test missed it.

### Fixed

- **The scheduler walked itself into the rate limit after about 23 minutes.**
  The scheduler had a rule to tighten the spacing by 100ms after every 40
  clean requests, on the theory that an idle bucket refills faster.
  Discord's refill rate is fixed and waiting earns no credit, so the run
  was slowly walking back into the limit it had already learned.
  - Each step down needed 40 clean requests, so 680 clean requests, which
    is about 23 minutes at 0.5 deletions per second, before the first
    symptom appeared.
  - The spacing now only ever widens, and only when Discord says to. A
    clean request changes nothing.
  - Every throttle widens the spacing, not just the first one.
- **Two workers were taking half the tokens from each other.** The delete
  rate limit is one account-wide bucket, so a second worker does not add
  throughput. Each worker reserved its own slot and they fired one spacing
  apart, which is half the refill interval, so one of every pair was
  refused. Measured gaps were 103ms and 1898ms alternating, and Discord
  refused 38 of every 75 requests.
  - The default worker count is now **1**.
  - Slots reserved before a 429 arrived are given back, so the pause
    applies to every worker.

### Measured, before and after

Same plugin, same DM, same message pool:

| | Before | After |
| --- | --- | --- |
| Throttles in the first 2 minutes | 325 | **1** |
| Speed | 0.2/s | **0.7/s** |
| Requests refused | two thirds | one |
| Throttle count after 11 minutes | climbing | still 1 |
| Throttle count after 31 minutes | climbing | still 1 |
| Throttle count after 64 minutes | climbing | still 1 |

### The full AEGIS DM was cleared

The 1:1 DM with `astralthesis` (channel `1402318446934360155`) held **6,161
messages, 3,135 of them the user's**. It was cleared end to end with the
shipped plugin:

| | Before | After |
| --- | --- | --- |
| Total messages | 6,161 | 3,026 |
| The user's messages | 3,135 | **0** |
| The other person's messages | 3,026 | 3,026 (untouched) |
| Last run | - | 1,900 deleted, 1 throttle, 64m 3s, 0.5/s |

Verified by walking every page of the API after the run: 31 pages, 3,026
messages, **zero of them the user's**, and every one of the other person's
messages still there.

### The channel stayed healthy

The "Discord is not loading anything" symptom did not come back. The
progress window closed, the result toast appeared with the real counts, the
API round trip was 387 ms, and navigating away and back refetched the
channel normally.

One note for anyone checking this by hand: the AEGIS DM renders as a set of
collapsed **"N blocked messages"** placeholders rather than individual
message rows, because the user has the other person blocked. That is
Discord's own rendering for blocked users, not a plugin problem. The
placeholder counts add up to exactly the number of messages in the store
(43 + 17 + 3 + 4 + 10 + 3 = 80, and the store held 80), which is how it was
confirmed.

## [2.1.0] - 2026-11-07

The "Discord is not loading anything after I use delete all dm" bug, chased
to its actual root cause with a full CDP exception stack trace instead of
guessing.

### Fixed

- **The progress modal never closed, and the final result toast never
  appeared.** This was the real cause of the channel appearing stuck.
  - `openModal()` in Discord's `ModalStore` returns a **string modal key**,
    not a close function. The plugin was doing
    `closeModal = openModal(...)` and then calling `closeModal?.()`, which
    is calling a string. In the minified bundle that surfaces as
    `TypeError: c is not a function`.
  - The throw happened inside the `onConfirm` promise chain of Discord's
    confirm dialog, so it rejected the promise and the remaining statements
    in the run never executed: the modal stayed on screen and the result
    toast was never shown.
  - The captured stack confirmed the call site exactly:

    ```
    Uncaught (in promise) TypeError: c is not a function
        at d   (VencordRenderer:294:56211)   <- the plugin's onConfirm
        at async (VencordRenderer:28:4924)   <- Discord's confirmAction
        at async onClick (web.js:1:657075)
    ```

  - The plugin now keeps the returned key and closes it with Discord's
    `closeModal(key)`, exactly as Discord's own modal callers do.
- **The channel reload no longer throws.** The resync used
  `findByProps("loadMessages")`, which finds **no module** in Discord
  0.0.421 and returns `null`. Destructuring `{ loadMessages }` out of
  `null` threw, and the catch block swallowed it, so the channel was
  cleared but never refetched.
  - The resync now clears the ChannelMessages store entry directly and
    calls Discord's own `MessageActionCreators.fetchMessages`, which is
    the same code path the client uses when you open a channel.
- **The result toast now reports the truth.** With the modal closing
  properly, the toast shows the deleted count, skipped count, failure
  count, throttle count, elapsed time and the measured rate.

### Measured, for reference

A 45 second live trace of the shipped plugin with nothing else touching the
API, with the request layer instrumented to record every status and the gap
between requests:

```json
{
  "delCount": 22, "delOk": 22, "del429": 0, "del404": 0,
  "gapMin": 1922, "gapMedian": 2000, "gapMax": 2084,
  "maxInFlight": 2
}
```

Twenty-two deletes, twenty-two successes, zero wasted requests, and the
spacing held at 2000ms with a spread of 162ms from fastest to slowest.

Discord's delete rate limit is scoped to the **user**, not the channel, so
running two deletions at once halves both. The same plugin measured 164
throttles and 0.2/s while a second script was competing for the same
bucket. Do not run two deletions at once.

### Verified

Run against the live client with a full CDP exception listener attached,
capturing every `Runtime.exceptionThrown` event for the whole run:

| Check | Result |
| --- | --- |
| Messages deleted | 15 of 15 |
| Exceptions during the run | **0** |
| Exceptions after the run | **0** |
| Progress modal closed on completion | yes |
| Result toast shown | `15 messages deleted, took 12s (1.3/s)` |
| Channel store after the run | 1 entry, refetched from the API |
| Channel API round trip after the run | 369 ms |
| Deleted messages still on the server | 0 |

## [2.0.0] - 2026-11-07

The rewrite that came out of actually running the plugin against a DM with
3,135 of the user's own messages in it. Every change below was driven by a
measurement against the live Discord API, not by guesswork.

### Added

- **Live progress modal.** A run over a few thousand messages takes minutes,
  so the plugin now opens a modal showing how many messages have been
  deleted, the current rate in messages per second, an estimate of the time
  remaining, and how many times Discord throttled the request. The old
  plugin showed nothing until the very end.
- **Cancel button.** The progress modal has a Cancel button. The run stops
  within one chunk instead of finishing the whole page.
- **A "Currently saved" read-out in the settings panel.** So there is never
  any doubt about what value the plugin is actually using.
- **A "Saved" confirmation next to each setting** after you press Apply.
- **Rate and duration in the final toast.** The result toast now says how
  long the run took and the average messages per second.

### Changed

- **Deletion is now paced instead of bursty, and the pacing is measured
  rather than guessed.** The old plugin fired one delete per 1200ms.
  - Discord's delete bucket allows a burst of roughly 15 to 20 messages and
    then refills at about **one every two seconds**. The old 1200ms delay
    was slower than the burst allowed and still fast enough to hit the
    refill limit on long runs.
  - The new scheduler jumps straight to the measured refill interval when
    Discord throttles, instead of creeping towards it. The intermediate
    version that crept was measurably worse: it threw away roughly half of
    every run's requests as 429s.
  - Every request now counts. A run either deletes a message or waits, but
    it does not fire into a closed bucket and hope.
  - The honest number is that Discord's rate limit is the binding
    constraint, at about **0.5 deletions per second** in the steady state.
    Clearing 3,135 messages takes about 104 minutes and no plugin-side
    tuning can do better, because there is no bulk endpoint for DMs.
- **Removed the `delayMs` setting.** A fixed sleep was the wrong tool. It
  was either too slow (the 1200ms default) or, if lowered, caused a burst
  that Discord throttled. The pacing is now automatic and adapts to whatever
  the account's current bucket allows.
- **Replaced the `maxMessages` number input with a custom settings
  component.** Vencord's built-in number input has a bug: it writes your
  input to the settings store and then calls `BigInt()` on it to clamp it.
  `BigInt("1.5")` throws, which aborts the handler before the input's own
  state updates. The result is a value that is saved but never shown, so the
  field keeps displaying the old number and it looks like the edit was
  rejected. This was the cause of the "I can't save my settings and don't
  know if it was applied" complaint.
  - Verified live against the old build: typing `1.5` into the old field
    left the store at `1.5` while the field still displayed `200`.
  - The replacement keeps its own draft state, only commits whole numbers,
  - shows a red validation message for bad input, and
  - shows the stored value underneath so the applied value is always visible.

  Verified live against the new build, in the real settings UI:

  | Action | Old build | New build |
  | --- | --- | --- |
  | Type `1.5` | store becomes `1.5`, field still shows `200` | rejected with a message, store untouched |
  | Type `1500`, press Apply | value saved, no confirmation shown | value saved, field shows **Saved** |
  | Read the stored value | not visible anywhere | shown as **Currently saved: 1500** |
  | After a restart | value persists | value persists |
- **Local message removal is now batched.** The old plugin dispatched one
  `MESSAGE_DELETE` Flux event per message, which makes React re-render the
  message list once per message. That is what made the client crawl during
  a large run. The new plugin dispatches `MESSAGE_DELETE_BULK` once per
  chunk of ten.
- **Scanning and deleting are interleaved.** The old plugin collected the
  entire message history into memory first, so on a long DM the client sat
  idle for a minute before deleting anything and the confirmation dialog
  could not tell you the count until the end. The new plugin deletes each
  page as it reads it.
- **Default worker count dropped from 3 to 2.** Measured against the live
  API, a single sequential request already runs at 2.25 deletions per
  second with no throttling, while eight simultaneous requests produced a
  429 for nearly every one of them and finished *slower*. Two workers keeps
  the network busy without setting off the bucket.
  - This was later corrected to **1** in 2.2.0. Two workers fire one
    spacing apart from each other, which is half the refill interval, so
    one of every pair is refused. The account-wide bucket does not split
    into extra throughput.

### Fixed

- **Discord no longer gets stuck after a run.** The resync at the end of a
  run used Discord's own `CLEAR_MESSAGES` action. In this Discord build
  (0.0.421) that action calls a store method that does not exist, so it
  threw an uncaught `TypeError: c is not a function`. The channel's cached
  messages were dropped but the refetch never completed, leaving the
  channel empty and unresponsive. This is the "Discord is not loading
  anything after I use delete all dm" symptom.
  - The plugin now clears the channel's entry directly in Discord's
    ChannelMessages store and asks Discord to load the channel again. Same
    result, no error.

- **Cancel now takes effect promptly.** The old code only checked the cancel
  flag once per page, so cancelling a 100 message page meant waiting for
  all 100 deletes to finish.
- **The progress modal now actually updates.** The first version of the
  modal was handed a plain object that was mutated in place, so React never
  re-rendered it and the counter stayed on "Deleted 0 of 100". The modal
  now subscribes to a progress tracker.
- **Partial input no longer crashes the settings panel.** `BigInt()` on a
  decimal string throws, which took down Vencord's whole number input
  component.

### Measured, for reference

| Scenario | Before | After |
| --- | --- | --- |
| Requests wasted on 429s | roughly half of a long run | none |
| 3,135 message DM, estimated duration | ~63 min | ~104 min, which is Discord's floor |
| Progress feedback | none | live count, rate, ETA, throttle count |
| Cancel response time | up to a full page | one chunk (10 messages) |
| Channel state after a run | uncaught TypeError, channel stuck empty | resyncs cleanly |

The duration went **up**, not down, and that is the correct outcome. The old
plugin looked faster because it was throwing away half its requests and the
progress display did not exist to show it. The new one does the same work
without the wasted requests and tells you the truth while it happens.

## [1.0.0] - 2026-11-06

First public release.

### Added

- Right click any of your own messages in a DM to delete every message of
  yours in that DM.
- Right click a DM in the sidebar for the same action.
- A second action that deletes one of your messages and every newer message
  of yours in that DM.
- A confirmation dialog that states exactly how many messages will be
  deleted.
- Correct reporting of deleted, already-gone, skipped and failed messages.
- A `maxMessages` limit so a single run cannot run away.
- Detection and reporting of DMs too long to page through completely.
- Skipping of Discord system message types that cannot be deleted
  (recipient add and remove, call logs, channel name and icon changes).
- An `install.sh` that builds the plugin against the exact Vencord version
  the user already has, for both the regular Vencord install and the
  standalone Discord for Mac install.

### Known limitations at the time of release

- The client freezes for the duration of the run, because the plugin
  dispatched one re-rendering event per message.
- There is no progress display, so a long run looks like a hang.
- The `maxMessages` limit silently truncates the run.
- Deleting 1,000 messages takes over 20 minutes.

[Unreleased]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/releases/tag/v1.0.0
