# Rewind stopped tracking the live session, and the sidebar name shimmers too

**Shipped**: 2026-08-31 · **Surface**: chat rewind/fork, sidebar
(`src/features/chat/`, `src/features/sessions/`, `src/stores/sessions.ts`)

## What changed

Rewinding a message ("Rewind to here", the fork picker) or cloning a live
session from the sidebar no longer leaves the sidebar tracking the wrong
file. Both now re-sync `live[PhosphorId].diskPath` right after pi's `fork`/
`clone` RPC resolves, by re-running `bootstrapSession` (now exported from
`stores/sessions.ts`) alongside the existing transcript rehydrate.

Separately, a session's sidebar row now shimmers while its name is still the
temporary first-message text, matching the top bar. `naming.pending &&
'name-pending'` was added to both `SessionRow` and `PendingSessionRow` in
`Sidebar.tsx`.

## Why: pi's `fork` always branches to a new file

`rewind.ts` carried a comment asserting the `fork` RPC command "mutates the
current session in place, it does not create a new session file." That is
not what the installed pi core does. Reading the actual implementation
(`agent-session-runtime.js`'s `fork()`, `session-manager.js`'s
`createBranchedSession()`) shows every persisted fork — including `clone`,
which is `fork` at the current leaf — tears down the live runtime and
replaces it with one bound to a brand-new `TIMESTAMP_ID.jsonl` file, parented
to the original via `parentSession`. The live RPC connection survives
(same subprocess, only its internal session object swaps), which is why the
chat pane itself kept rendering correctly through a rewind — but Phosphor never
re-asked `get_state` afterward, so `live[PhosphorId].diskPath` kept pointing at
the file pi had just abandoned.

The visible symptom was two identically-named sidebar rows after a rewind:
the stale pre-fork file stayed marked "live" (`liveByDisk` matches on
`diskPath`, so it kept the active highlight), while the real, actively
written branch showed up as an unclaimed row with no live owner. From the
chat pane — the one place a user was actually watching — nothing looked
wrong, which is what made this read as the chat having silently duplicated
itself rather than as a stale sidebar entry.

`bootstrapSession` already did exactly the needed work (`get_state` →
`live[PhosphorId].diskPath`, plus a `refreshDisk` of the folder) for the
create/adopt path, so the fix reuses it rather than re-deriving a smaller
version of the same sync.

## Why the shimmer changed too

`.name-pending`'s doc comment recorded a deliberate prior call: shimmering
was cut back from four surfaces (both sidebar row types, the top bar, the
branch chip) to just the top bar, because one naming event lighting up four
animations at once read as busy. Re-adding it to the sidebar rows brings
that back up to three — but a session's title is watched in the sidebar list
at least as often as in the top bar, and a temporary name sitting motionless
there reads as settled rather than still in flight. The branch chip stays
arrival-only on purpose, so one event still tops out at two shimmering
surfaces, not four.

## Verification

- `rewind.test.ts` (new) — a successful fork relearns `diskPath` from
  `get_state`; a cancelled fork touches neither `diskPath` nor the
  transcript; a failed `fork` RPC call does nothing further.
- `sidebarActions.test.ts` (new) — cloning a live session relearns
  `diskPath` the same way; a cancelled clone leaves it alone.
- Full `npm run validate` (typecheck, lint, format, unit) and
  `npm run test:e2e` (34/34) both green — the shimmer is a pure CSS/class
  change with no dedicated test, verified instead by seeding a live "naming"
  session through the browser mock harness and sampling
  `getComputedStyle(...).backgroundPosition` over time to confirm the
  gradient animation actually progresses under the new class.
