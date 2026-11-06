# BulkDeleteDm

A Vencord plugin that bulk deletes **your own** messages inside DMs and group DMs.

Discord has no bulk-delete for DMs. The official bulk endpoint
(`POST /channels/{id}/messages/bulk-delete`) is bot-only and only works on
guild channels with the `MANAGE_MESSAGES` permission, and bots cannot join
1:1 DMs at all. What does work is deleting a single message with
`DELETE /channels/{id}/messages/{message_id}`, so this plugin walks your DM
history and deletes your messages one at a time, paced to stay inside
Discord's rate limit.

## What it does

- Right-click a DM in the sidebar, or right-click one of your own messages in a
  DM, and pick **Delete All My Messages In This DM**.
- Also offers **Delete This Message And My Newer Ones** when you right-click
  one of your own messages.
- Only ever deletes messages **authored by you**. Other people's messages are
  never touched.
- Works in both 1:1 DMs and group DMs.
- Shows a live progress window with a running count, the current speed, an
  estimate of the time remaining, and a **Cancel** button.

## Install

Vencord has no runtime plugin folder. A user plugin has to be compiled into the
Vencord bundle, so installing this means rebuilding Vencord once. The script
below does the whole thing.

### Option 1: the script (recommended)

```bash
git clone https://github.com/Harishisonline/vencord-bulk-delete-dm.git
cd vencord-bulk-delete-dm
./install.sh
```

The script detects whether you use the regular Vencord installer or the
standalone Vencord that ships with Discord for Mac. Force it if the detection
is wrong:

```bash
./install.sh --standalone   # Discord for Mac (standalone Vencord)
./install.sh --regular      # regular Vencord (Windows, Linux, Mac installer)
```

Requirements: `git`, `node` (20 or newer), and `pnpm`. See
[Vencord's install guide](https://docs.vencord.dev/installing) for how to get
those.

Restart Discord afterwards. The plugin appears under **Settings > Plugins >
BulkDeleteDm**.

### Option 2: manual

1. Clone and build Vencord following the
   [official guide](https://docs.vencord.dev/installing).
2. Copy `src/userplugins/bulkDeleteDm/index.tsx` from this repo into your Vencord
   checkout, at `src/userplugins/bulkDeleteDm/index.tsx`.
3. Run `pnpm build` (or `pnpm build --standalone` for Discord for Mac).
4. Install the build with `pnpm inject`, or copy `dist/renderer.js` over the one
   in your Vencord install directory.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Maximum messages per run | 200 | How many of your messages to delete in one run. Set it to `0` for no limit, which walks the entire DM. |
| Delete requests running at once | 2 | How many delete requests run in parallel. Two is the sweet spot. |
| Ask for confirmation | on | Ask before deleting. |
| Remove from view | on | Remove deleted messages from the chat view. Turn it off if you use MessageLogger and want its red "deleted" markers. |

Each numeric setting has its own **Apply** button and shows the value that is
currently saved underneath it, so you can always see what the plugin is
actually using.

## Limits and behaviour worth knowing

**There is a limit.** A single run deletes at most the maximum you set (200 by
default). If a DM holds more of your messages than that, the plugin deletes
the newest ones and tells you it stopped at the limit. Set the maximum to `0`
to walk the whole DM in one go.

**How long it takes.** Deleting a message is one HTTP request, and Discord
rate limits how fast they can be made. The sustained rate, measured against
the live API over runs of 150 to 300 messages, is about **0.6 to 0.7 deletions
per second** once the initial burst allowance is spent. A DM with 3,000 of
your messages in it therefore takes roughly **75 minutes**, and there is no
way around that limit from a user plugin. Discord's own bulk delete endpoint,
which would do 100 messages per request, is restricted to bots and to guild
channels.

The first handful of messages in a run go faster than that, because Discord
allows a short burst before the limit starts biting. The burst is real but
small, roughly 15 to 20 messages, and it does not change the total.

**Discord's own limits still apply.**

- Deleting messages is rate limited. Discord does not send rate limit headers
  on successful deletes, so the plugin has to infer the limit from the `429`
  responses. It paces its requests evenly and pauses for exactly as long as
  Discord asks when it gets one. Pacing matters more than parallelism here:
  firing requests in bursts makes Discord throttle the account and the run
  ends up **slower**, not faster. Measured: 8 parallel requests produced a
  `429` for nearly every one of them and finished slower than a single
  sequential worker.
- Messages older than 14 days can only be bulk deleted in **guild** channels.
  That rule does not apply here, because the plugin deletes messages
  individually, and it does work on old DM messages.
- Some Discord system messages cannot be deleted by anyone, even their author.
  Call and thread-system messages are examples. The plugin skips these and
  reports them as `skipped`, not as a failure.
- The message list endpoint returns at most 100 messages per request, so
  reading a long DM takes several requests. The plugin pages backwards
  automatically, so this only affects speed, not results. Discord does not
  document a hard cap on how far back a DM's history goes, and in testing a
  DM with over 60,000 messages still paged all the way back.

**How far back a run reaches.** The plugin reads the DM newest-first and
deletes your messages as it finds them, so one run always covers the
**newest** messages in the DM. If a DM has more of your messages than the
limit, raise the maximum and run it again to reach further back.

**Deleted messages can linger in the chat view.** This is the single most
common "it says it deleted them but I can still see them" report, and it is
worth understanding what is actually happening.

Discord's REST delete does not emit a gateway `MESSAGE_DELETE` back to your
own client. When the plugin deletes a message through the API, Discord's
server removes it, but your client keeps its own cached copy of that message
and keeps rendering it. The message is gone from the server but still on your
screen.

On top of that, [MessageLogger](https://github.com/Vendicated/Vencord/tree/main/src/plugins/messageLogger)
(which many people run) intercepts the local delete event and keeps the
message in the store marked `deleted: true`, painting it **red** instead of
removing it. That is exactly what MessageLogger is designed to do, and it is
why you end up with a mix of red and white rows: red means "MessageLogger
logged this deletion", white means "this row was never reconciled locally".

The plugin handles both cases:

- `Remove from view: on` (default) removes deleted messages from the
  local store in batches, then clears and refetches the channel so the view
  matches the server exactly. No red rows, no stale rows.
- `Remove from view: off` dispatches a plain delete event, which leaves
  MessageLogger's red markers in place. Use this if you want MessageLogger's
  deletion log.

After a run the plugin clears the channel's cached messages and asks Discord
to load the channel again, so the view should end up matching the server. If
the chat still looks stale, reload the Discord window (`Cmd+R` / `Ctrl+R`) to
force a refetch.

**If the progress window will not go away.** A stuck progress window means the
run threw before it could close itself. Reload the Discord window (`Cmd+R` /
`Ctrl+R`). The deleted messages are gone from the server either way, so
reloading only fixes the display.

**Counts.** The toast after a run reports exactly what happened: how many were
deleted, how many were skipped as undeletable system messages, how many
failed, how long it took, the average speed, and whether the maximum was hit.
A message counted as deleted was accepted by Discord's API and is gone from
the server.

## Safety

- The plugin only deletes messages where `author.id` is your own user ID.
- It never deletes anyone else's messages.
- Discord's "delete" is a hard delete. There is no undo and no trash folder.
- The plugin shows a confirmation with the count before it runs.
- You can cancel a run at any point from the progress window.

## Changelog and development notes

- [CHANGELOG.md](CHANGELOG.md) lists every change between releases.
- [betterment.md](betterment.md) explains what was slow or broken, the
  measurements behind each fix, and what is still on the list.

## Disclaimer

This is an unofficial plugin and is not affiliated with Discord or Vencord.
Deleting your own messages is a normal Discord operation, but you are
responsible for your account. Use it on your own account and messages only.

## Uninstall

Remove the plugin and rebuild, or reinstall the stock Vencord build. The
`install.sh` script keeps a `renderer.js.bak` next to the file it replaced in a
standalone install.
