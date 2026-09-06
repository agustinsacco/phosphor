# docs/specs/backlog

Audits with findings that are **not all resolved** — so unlike a landed plan,
these are still worth reading for work to do.

| File                                                       | Scope                                           | Open as of 2026-08-30 |
| ---------------------------------------------------------- | ----------------------------------------------- | --------------------- |
| [perf-findings.md](perf-findings.md)                       | Memory and CPU on the pi → main → renderer path | 17 of 19 findings     |
| [cleanup-plan.md](cleanup-plan.md)                         | Duplication, dead code, module size             | Phase 6 + 1 loose end |
| [connectors.md](connectors.md)                             | OAuth MCP connectors: catalog, auth, status     | 1 of 7 findings       |
| [spec-drift-2026-08-30.md](spec-drift-2026-08-30.md)       | Every `reference/` doc vs. the code             | 30 of 44 findings     |
| [mid-turn-loss-2026-08-30.md](mid-turn-loss-2026-08-30.md) | An app exit discards the whole in-flight turn   | 5 of 5 findings       |
| [tool-call-ui.md](tool-call-ui.md)                         | Tool-call and MCP row rendering, both providers | 8 of 8 findings       |

[Engineering workbench review (2026-09-05)](ai-workbench-review-2026-09-05.md):
visuals, interaction and delivery workflow; 12 open findings at `ae57ae3`, with
observed behavior separated from code-traced risks and future design proposals.

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
