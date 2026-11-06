# BulkDeleteDm

A Vencord plugin that bulk deletes **your own** messages inside DMs and group DMs.

Discord has no bulk-delete for DMs. The official bulk endpoint
(`POST /channels/{id}/messages/bulk-delete`) only works on guild channels and
needs the `MANAGE_MESSAGES` permission, and bots cannot join 1:1 DMs at all.
What does work is deleting a single message with
`DELETE /channels/{id}/messages/{message_id}`, so this plugin walks your DM
history and deletes your messages one at a time.

## What it does

- Right-click a DM in the sidebar, or right-click one of your own messages in a
  DM, and pick **Delete All My Messages In This DM**.
- Also offers **Delete This Message And My Newer Ones** when you right-click
  one of your own messages.
- Only ever deletes messages **authored by you**. Other people's messages are
  never touched.
- Works in both 1:1 DMs and group DMs.

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
| `delayMs` | 1200 | Delay between delete requests. Raise it if you hit rate limits. |
| `maxMessages` | 200 | Most messages to delete in one run. Raise it if a DM has more than this. |
| `confirmBeforeDelete` | true | Ask before deleting. |
| `removeFromView` | true | Remove deleted messages from the chat view. Turn it off if you use MessageLogger and want its red "deleted" markers. |

## Limits and behaviour worth knowing

**There is a limit.** A single run deletes at most `maxMessages` (200 by
default) messages. If a DM holds more of your messages than that, the plugin
deletes the newest 200 and tells you it stopped at the limit. Raise
`maxMessages` and run it again to clear the rest.

**Discord's own limits still apply.**

- Deleting messages is rate limited. The plugin waits between requests and
  backs off automatically when Discord returns `429`, but a very large cleanup
  can still take a while at the default delay.
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
  DM with over 12,000 messages still paged all the way back.

**How far back a run reaches.** The plugin reads the DM newest-first and
collects your messages until it has `maxMessages` of them, so one run always
covers the **newest** messages in the DM. If a DM has more of your messages
than the limit, run it again after raising `maxMessages` to reach further
back.

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

- `removeFromView: true` (default) removes each deleted message from the
  local store outright, then clears and refetches the channel so the view
  matches the server exactly. No red rows, no stale rows.
- `removeFromView: false` dispatches a plain delete event, which leaves
  MessageLogger's red markers in place. Use this if you want MessageLogger's
  deletion log.

If the chat still looks stale after a run, reload the Discord window
(`Cmd+R` / `Ctrl+R`) to force a refetch.

**Counts.** The toast after a run reports exactly what happened: how many were
deleted, how many were skipped as undeletable system messages, how many
failed, and whether the `maxMessages` limit was hit. A message counted as
deleted was accepted by Discord's API and is gone from the server.

## Safety

- The plugin only deletes messages where `author.id` is your own user ID.
- It never deletes anyone else's messages.
- Discord's "delete" is a hard delete. There is no undo and no trash folder.
- The plugin shows a confirmation with the exact count before it runs.

## Disclaimer

This is an unofficial plugin and is not affiliated with Discord or Vencord.
Deleting your own messages is a normal Discord operation, but you are
responsible for your account. Use it on your own account and messages only.

## Uninstall

Remove the plugin and rebuild, or reinstall the stock Vencord build. The
`install.sh` script keeps a `renderer.js.bak` next to the file it replaced in a
standalone install.
