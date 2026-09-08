# Post-compaction stall, and the meter that took the usage fetch with it

_2026-09-03_

Two reports, one shared cause and one coincidence.

1. After a compaction the model stops continuing. The first message does
   nothing. The second usually does nothing. The third finally wakes Claude
   Code up.
2. The context ring and its popover are missing, and the 5-hour / weekly plan
   usage often never appears.

The first is a `@saccolabs/pi-claude-cli` bug. The second is Phosphor's.

## 1. A result the CLI spent on its own queued prompt

Fixed in the provider, not here: **`@saccolabs/pi-claude-cli` 0.6.1**, shipped
inside the published 0.7.0.

On `--resume` the CLI drains its own queue before ours. A session whose
previous turn launched a background task gets a `<task-notification>` enqueued
ahead of our prompt — "background shell command task(s) from the previous
session have no completion record" — because the provider exits the CLI
process at the end of every turn and orphans exactly those tasks. Compaction
makes this common: the turn that compacts is long, and long turns are the ones
that spawn background work.

The CLI dequeues the notification, decides it needs no reply, and emits
`result` in under a second, having never called the model. The provider ended
the episode there. pi received an assistant message with empty content and
`totalTokens: 0` — the signature described in
[Debugging a failing session](../../CLAUDE.md) — and our prompt was still
sitting in the CLI's queue.

**That also explains the cache.** Ending on that result left the CLI's own
transcript finishing on an unanswered user entry, so the _next_ `--resume`
spliced repair filler in ("Continue from where you left off." / "No response
requested."). The filler changes the cached prefix, so the entire conversation
re-billed as a cache **write**. Measured on claude 2.1.258: 329,944
cache-creation tokens and zero cache read on the repairing resume, against
~400 write / ~315k read on every healthy cycle of the same session.

The fix: a `result` that carried no content **and** spent no tokens is a cycle
boundary, not the end of the episode. Both halves are required — a model that
legitimately answers with silence still bills for the call, so usage is what
separates "said nothing" from "never ran". Bounded at 4 continuations, with
the existing inactivity timer still the backstop.

Usage accounting across the extra cycles needed no change: `recomputeUsage`
already sums cumulative + cycle usage and latches the newest non-zero cycle
context, so an empty result contributes zero and cannot clobber a real figure.

Requires `>= 0.6.1`. Check what is installed before re-diagnosing this:

```bash
jq -r .version ~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/package.json
```

## 2. The meter unmounted, so nothing ever asked for usage

`ContextMeter` returned `null` when `stats.contextUsage.percent` was null.
That is not a rare state — pi reports null context tokens from the moment a
session compacts until fresh usage arrives. So the ring disappeared for the
same window in which report 1 was happening, which is why the two arrived
together and looked like one bug.

The ring is the only trigger for the popover, and the popover's mount is the
only thing that fires `claude:usageSnapshot`. No ring, no popover, no fetch —
"usage never showed up" was, in almost every case, a fetch that never ran.

Three changes:

- **The meter renders whenever the session has stats.** A null percentage
  draws the ring unfilled and shows `—`; the Window row reads `measuring`.
  It no longer takes the popover down with it.
- **Plan usage always renders a row.** `Checking…` in flight, then the windows
  or a one-line reason there are none. A rejected `invoke` is caught and read
  as `run-failed`, so a missing handler cannot pin the section on `Checking…`
  forever. The reason strings moved to `usageUnavailableReason` in
  `src/lib/claudeUsage.ts`, shared with Settings → Claude Code so the two
  surfaces cannot disagree about the same failure.
- **Plan usage is gated to Claude Code sessions** (`isClaudeCliModel`, matching
  `provider`/`api` `pi-claude-cli` — verified against `get_available_models`).
  Plan usage is an account-level fact about that CLI; on a Bedrock or pi-native
  session it would report a limit that governs nothing.

Tests: `src/lib/claudeUsage.test.ts` and `src/features/chat/composer/ContextMeter.test.tsx`.
