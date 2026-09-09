# docs/specs/build

**Historical. Written before the code existed, and never revised since.** Where
one of these disagrees with [the feature docs](../..) or with the code, it
is wrong — do not implement from it.

They are kept because they record the original intent, and several decisions in
the code only make sense against them.

| File                                     | Written    | Known to be stale in                                                                                                                 |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [05-files-editor.md](05-files-editor.md) | 2026-08-03 | "Git (read-only v1) / No commit UI in v1" — superseded by the full worktree + branch lifecycle in [worktrees.md](../../worktrees.md) |
| [07-artifacts.md](07-artifacts.md)       | 2026-08-03 | Describes one bundled extension; **six** ship today ([extensions.md](../../extensions.md))                                           |
| [08-sessions.md](08-sessions.md)         | 2026-08-03 | "`-e` artifacts always applied" — the bundled set is **six**, applied to every session; there are no orchestrator sessions any more  |
| [10-packaging.md](10-packaging.md)       | 2026-08-03 | "Release (tag push)" — releases now ship on every green merge to `main`, versioned `0.1.<commit count>` (see the README)             |

The rest of the original `00`–`10` set was promoted into `reference/` once it
started being maintained: `00`→`overview`, `01`→`architecture`,
`02`→`pi-integration`, `03`→`ui-shell`, `04`→`chat`, `06`→`terminal`,
`09`→`settings`. The gaps in the numbering above are those promotions, which is
why the numbers here no longer read as a sequence.
