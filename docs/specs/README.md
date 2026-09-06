# docs/specs

**Work that is not done.** Open findings, phase state, and the original
pre-implementation intent. Nothing here describes shipped behaviour — for that,
read [the feature docs](..).

This is a running folder. Entries arrive when work is deferred and leave when
it lands or is abandoned. It is expected to be untidy in a way `docs/` is not.

| Path                                         | Holds                                                                                        | Trust it?                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [TRACKER.md](TRACKER.md)                     | Phase state and the few remaining open boxes.                                                | For status, yes. Not for behaviour.            |
| [backlog/](backlog/)                         | Audits with findings that are not all resolved.                                              | Per-finding — check each status column.        |
| [build/](build/)                             | Original requirements, written before the code existed.                                      | **No.** Historical intent only.                |
| [vision-ui-renewal.md](vision-ui-renewal.md) | A UI/UX renewal direction: pidex as an attention instrument (deck, lane, line, house, body). | As direction only. Nothing in it is scheduled. |

## backlog/

[perf-findings.md](backlog/perf-findings.md) (memory and CPU on the streaming
path), [cleanup-plan.md](backlog/cleanup-plan.md) (duplication and dead code),
and [connectors.md](backlog/connectors.md) (OAuth MCP connectors). All are
per-finding status tables, not prose backlogs — a finding is only closed when
its row says so. See [backlog/README.md](backlog/README.md).

## build/

The survivors of the original `00`–`10` build set, kept because they record
intent the code still reflects. Everything else was promoted into `docs/` or
superseded. Where one disagrees with `docs/` or with the code, it is wrong —
do not implement from it. See [build/README.md](build/README.md).

## Adding to this folder

- **A deferred finding** goes in the relevant `backlog/` table with a status,
  not in prose. A finding with no status is invisible within a week.
- **A numbered phase** gets a dated note in its own Log section in
  `TRACKER.md`. Never append a new section to the end — a shared append point
  is what made unrelated PRs conflict there.
- **Anything that shipped** does not belong here. It goes in
  [../log/](../log/) as a dated write-up, and the behaviour it changed goes in
  the matching `docs/` file in the same diff.
