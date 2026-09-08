# Rewind gives the whole message back, and stops leaving a dead row behind

**Shipped**: 2026-09-01 · **Surface**: chat rewind / fork picker, sidebar
(`src/features/chat/`, `src/features/sessions/`, `electron/pi/session-fold.ts`)

## What changed

Rewinding a message now restores its **images** as well as its text into the
composer, and the session file the rewind branched away from no longer shows
up as a second sidebar row in the same lane.

## Why: pi's `fork` gives back less than it takes

Both halves come from the same place — pi's `fork` RPC, the one mechanism
behind the per-message rewind button, the fork picker and `clone`.

**Images.** `fork` replies with `selectedText`, built by pi's
`extractUserMessageText`, which keeps text blocks and drops everything else.
So a rewound message that carried a screenshot came back as prose with the
screenshot silently gone — and the user had no copy left, because the
transcript had already been rewound past it. The fix does not go to pi for
them: `imagesForUserMessageOrdinal` reads them out of the rendered transcript,
which is the only surviving copy, using the same ordinal contract
`entryIdForUserMessageOrdinal` already relies on (`get_fork_messages` and the
transcript derive from the same on-disk entries). The composer's prefill is
now `{ text, images }` instead of a bare string.

**The extra row.** `createBranchedSession` copies the entries up to the branch
point into a new `TIMESTAMP_ID.jsonl` and abandons the original. PR #144 fixed
_which_ of the two Phosphor marked live; the abandoned file itself was still on
disk, so the sidebar kept a full second row with the same name and the same
`wt` chip. That reads as the lane having duplicated itself.

`dropSupersededSessions` hides it. The discriminator is deliberately two
fields, not one: `parentSession` alone is ambiguous, because pi records it for
a plain `/new` successor session too, and hiding a `/new`'s predecessor would
delete real history from the sidebar. Only a branch _copies_ its parent's
entries, so only a branch repeats the parent's first entry id — hence the new
`firstEntryId` on `SessionMeta`, folded in `session-fold.ts` and set once so
the incremental re-fold (which never sees line 1 again) cannot clobber it. A
live session is never hidden, since `bootstrapSession` relearns the branch
path asynchronously and the abandoned file is briefly still the claimed one.

Nothing is deleted: the bytes stay, this is presentation only.

## What pi-claude-cli does under a rewind — checked, no change needed

A rewind mints a **new pi session id** (`createSessionId()` inside
`createBranchedSession`), so `getCliSession(piSessionId)` misses, and
`pi-claude-cli` starts a fresh CLI session and reimports the truncated history
rather than `--resume`-ing the one that still contains the discarded turn.
That is the correct behaviour and it already happens; verified against
0.5.1's `provider.ts` and `session-map.ts`. It costs one full reimport per
rewind, which is the price of the rewind actually taking effect on the Claude
side.

## Verification

- `superseded.test.ts` (new) — branch hidden, chains collapsed, `/new`
  predecessor kept, live kept, pre-`firstEntryId` files kept.
- `rewind.test.ts` — images ride along into the prefill; ordinal lookup skips
  optimistic items.
- `session-fold.test.ts` — `firstEntryId` survives a resumed fold.
- `npm run validate` (typecheck, lint, format, unit) and `npm run test:e2e`.
