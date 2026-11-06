# Changelog

All notable changes to BulkDeleteDm are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

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
  - Verified live: typing `1.5` into the old field left the store at `1.5`
    while the field still displayed `200`.
  - The replacement keeps its own draft state, only commits whole numbers,
  - shows a red validation message for bad input, and
  - shows the stored value underneath so the applied value is always visible.
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

[Unreleased]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v1.0.0...HEAD
[2.0.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Harishisonline/vencord-bulk-delete-dm/releases/tag/v1.0.0
