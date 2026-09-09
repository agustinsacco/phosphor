# docs/specs/backlog

Audits with findings that are **not all resolved** — so unlike a landed plan,
these are still worth reading for work to do.

Every row below was re-verified against the code on **2026-09-09**, finding by
finding. This table is the whole directory — if a file is here it has a row.

| File                                                                   | Scope                                           | Open as of 2026-09-09 |
| ---------------------------------------------------------------------- | ----------------------------------------------- | --------------------- |
| [perf-findings.md](perf-findings.md)                                   | Memory and CPU on the pi → main → renderer path | 13 of 19 findings     |
| [mid-turn-loss-2026-08-30.md](mid-turn-loss-2026-08-30.md)             | An app exit discards the whole in-flight turn   | 5 of 5 findings       |
| [tool-call-ui.md](tool-call-ui.md)                                     | Tool-call and MCP row rendering, both providers | 5 of 8 findings       |
| [ai-workbench-review-2026-09-05.md](ai-workbench-review-2026-09-05.md) | Workbench direction: trust, recovery, delivery  | 10 of 12 findings     |
| [cleanup-plan.md](cleanup-plan.md)                                     | Duplication, dead code, over-export             | 4 of 5 findings       |
| [phosphor-refinement-2026-09-05.md](phosphor-refinement-2026-09-05.md) | Visual/UX direction, companion to the review    | Proposal — see header |

Two of those need a word before you read them. **`mid-turn-loss`'s findings are
all live but its implementation plan is not** — it was written against
`FleetHub`, which no longer exists. **`phosphor-refinement` is a proposal, not
a finding list**; roughly a third of it shipped and its header says which.

Deleted 2026-09-09, at zero open findings — recover from `git show f6c90c9:<path>`:

| File                              | Why                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `spec-drift-2026-08-30.md`        | All 44 doc claims resolved — 30 by fixing the docs in this pass, 14 mooted by the orchestration removal |
| `connectors.md`                   | 6 of 7 fixed; the seventh is a permanent upstream constraint, now rule 3 in [mcp.md](../../mcp.md)      |
| `session-polish-pr-2026-09-05.md` | Every item verified shipped in #194–#199; the six dated logs are the record                             |

## The rule that keeps these useful

**Every finding carries its own status, and the status is re-verified against
the code — never inferred from this file.** These documents lose their value the
same way: they listed real, measured problems, work landed against some of them,
and nothing recorded which. A reader then cannot tell a live bug from a fixed
one, so they trust none of it.

Status values: `open` (reproduces today) · `fixed` (name the commit or the file
that fixed it) · `moot` (the code it described no longer exists).

When you fix a finding, update its row in the same PR. When a file reaches zero
open findings, delete it — the findings are fixed, the code is the record, and
git keeps the audit.

**Re-verify against the code, not against the last re-verification.** The
2026-09-09 pass found the status column wrong in both directions, and each
error came from trusting a previous pass rather than reading the source:

- `perf-findings` F14 was marked fixed by a note that credited the TTL cache on
  `gitInfoBatch` — but F14 is about `gitInfo`, the sibling function, which is
  still uncached. A live medium-severity finding sat filed as solved for
  thirteen days.
- `perf-findings` F7 was genuinely fixed, and then **regressed** when the idle
  session reaper was deleted with the orchestration removal. Nothing re-opened
  it. A `fixed` row is not permanent; a later removal can undo it.
- `cleanup-plan`'s phase-4 loose end was `open` but had already been resolved
  in the code, so a reader was sent to do work that was done.

A status is a claim about the code as of a date. Write the date next to it.
