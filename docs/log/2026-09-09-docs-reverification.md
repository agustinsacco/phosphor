# Every doc claim re-verified against the code, and what a rename had hidden

**2026-09-09.** `docs/` is the folder this repo tells readers to trust — "how
Phosphor works today", and if the code disagrees, the doc is wrong. That rule
had not been enforced since 2026-08-30. This pass read every living contract
and every backlog finding against the source: **107 claims checked, 63 found
false or stale.**

## The thing worth remembering: a rename is not a review

Every file in `docs/` has a last-commit date of 2026-09-08, which reads like a
freshly maintained folder. It was the pidex→Phosphor rename — a find-and-replace
that touched the exact lines that were wrong and left every one of them wrong.
`docs/chat.md` is the clean example: the rename rewrote its command list to say
"Phosphor-native commands" while leaving all eight command names, five of which
have never existed. Zero of that file's seven known drift findings were fixed
by a pass that edited all seven lines.

Worse, the sed **capitalised three string literals**. The extension status
channel (`phosphor-context-breakdown`, `phosphor-mcp-status`,
`phosphor-headroom`) is called "a wire contract" by its own documentation, and
the docs had been silently rewritten to `Phosphor-…`. Nothing checks these keys
on either side, so anyone implementing against the doc would have written a
publisher that renders nothing, with no error anywhere. That is the whole cost
of the rule in one bug: a doc that is wrong about a literal is worse than no
doc.

`docs/README.md` gained a third rule about this. A doc whose last commit is a
rename has not been verified.

## What was actually wrong

The drift audit's own count was 44 claims; re-verification found 63, because it
had itself gone stale. The largest cluster — 14 findings about
`docs/orchestration.md` — was moot: that document and `electron/orchestrator/`
were deleted on 2026-09-03, and [that removal log](2026-09-03-remove-orchestration.md)
cites this audit's drift count as part of its reason.

Of the rest: `architecture.md` claimed 13 IPC prefixes (there are 17), named
three main-process classes that do not exist (`WorkspaceManager`,
`SessionManager`, `FsService`), and listed `layout` as an electron-store pref
when panes live in localStorage. `pi-integration.md` said `-e` loads "the
bundled artifacts extension" — six ship. `settings.md` documented a _window_
with 7 sections; it is a modal with 13 tabs, six of them undocumented.
`chat.md` promised code-block line numbers, mermaid PNG export and a "fork from
here" action, none of which exist, and described the artifact iframe as
"inlined content" when the entire security argument for it turns on it _not_
being `srcdoc`. `terminal.md` contradicted itself about the shell's cwd inside
twenty lines.

All of it is now fixed against the source rather than deleted, and the drift
audit was deleted at zero.

## A status is a claim about a date

The backlog's rule is that a finding carries its own status, re-verified
against the code and never inferred from the file. Re-verifying found the
column wrong **in both directions**, each error caused by trusting the previous
pass instead of reading the source:

- **`perf-findings` F14 was never fixed.** A 2026-08-27 note marked it solved
  by the TTL cache on `gitInfoBatch`. F14 is about `gitInfo`, the sibling
  function, still uncached and still spawning four `git` processes per
  debounced `fs:changed`. A live medium-severity finding sat filed as solved
  for thirteen days.
- **`perf-findings` F7 regressed.** It _was_ genuinely fixed by the idle-session
  reaper, and then the reaper was deleted wholesale with the orchestration
  removal. Nothing re-opened the row. A `fixed` status is not permanent — a
  later removal can undo it.
- **`cleanup-plan`'s phase-4 loose end was already resolved** in the code while
  the doc still called it open, which sends a reader to do work that is done.

`tool-call-ui` moved the other way: three of its eight findings are fixed
(two in-repo, one upstream in `pi-claude-cli` 0.7.1), and its headline is now
half-obsolete — the bash-truncation complaint is solved, the MCP half is
exactly as true as when it was written.

## Deletions

Three files reached zero open findings and were deleted, per the backlog's own
rule. Recover any of them with `git show f6c90c9:<path>`:

- `spec-drift-2026-08-30.md` — 30 resolved by fixing the docs in this pass, 14
  mooted by the orchestration removal.
- `connectors.md` — six of seven fixed. The seventh is not a bug to fix but a
  permanent upstream constraint (pi's RPC has no server→client cancel, so
  Phosphor must never auto-answer the adapter's callback prompt), now written
  up as rule 3 in [docs/mcp.md](../mcp.md) where it will actually be read.
- `session-polish-pr-2026-09-05.md` — every item verified shipped in #194–#199.
  It still said "awaiting merge", and it still claimed two-line lane titles
  were implemented when #204 deliberately reverted them — a live instruction to
  re-do work that had been undone on purpose.

`cleanup-plan.md` went from 585 lines to 80: phases 1–5 landed, and their
bodies described work that is now simply the code.

## Mechanical

Seven dangling links repaired, and the two dated logs whose subject was later
deleted (the orchestrator, the session reaper) now say so at the top instead of
reading as current behaviour. `TRACKER.md`'s P11 phases 2 and 3 were ticked —
both had shipped by other routes and nobody reconciled the boxes; phase 5 grew,
because there are now three banner implementations, not the two it recorded.
`CLAUDE.md` said three extension-fed UI surfaces; there are five.

Verified with `npm run validate` (typecheck, lint, format, unit — all green)
and a link check across all 190 markdown files.
