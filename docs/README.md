# pidex documentation

**How pidex works today.** Every file here describes shipped behaviour. If one
disagrees with the code, the file is wrong and fixing it is part of the change
that broke it.

Two neighbours hold other genres, and they are not interchangeable:

| Folder           | Holds                                                            | Trust as current? |
| ---------------- | ---------------------------------------------------------------- | ----------------- |
| `docs/` (here)   | Living contracts. How a feature behaves now.                     | **Yes**           |
| [log/](log/)     | One dated write-up per shipped change: what broke and why.       | As history only   |
| [specs/](specs/) | Work not yet done — open findings, phase state, original intent. | As intent only    |

## Feature docs

Start with [overview.md](overview.md) for what pidex is, or
[architecture.md](architecture.md) for how the processes fit together.

| File                                   | Covers                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| [overview.md](overview.md)             | Product definition, non-negotiables, engineering quality bar       |
| [architecture.md](architecture.md)     | Process model, IPC design, cross-cutting requirements              |
| [pi-integration.md](pi-integration.md) | pi's RPC protocol and session format — the load-bearing document   |
| [style-guide.md](style-guide.md)       | The Phosphor visual identity. Authoritative on all colour and type |
| [ui-shell.md](ui-shell.md)             | Window chrome, top bar, sidebar, pane system, theming              |
| [chat.md](chat.md)                     | Transcript rendering, composer, tool cards                         |
| [files.md](files.md)                   | Explorer file management, transfers, clipboard and editor behavior |
| [terminal.md](terminal.md)             | PTY panes, clipboard, scrollback, per-session ownership            |
| [settings.md](settings.md)             | The settings window and which config file each tab writes          |
| [updates.md](updates.md)               | Update detection, the three install paths, and the macOS swap      |
| [worktrees.md](worktrees.md)           | Git worktree lifecycle and the branch control                      |
| [mcp.md](mcp.md)                       | MCP servers via the pi-mcp-adapter config chain                    |
| [extensions.md](extensions.md)         | The bundled pi extensions; provider transcript shapes              |
| [cli-providers.md](cli-providers.md)   | Running sessions on external CLI providers (Claude Code)           |

## Two rules that keep this workable

1. **One fact, one home.** If a doc here and anything else disagree, this
   folder is right and the other file gets fixed or deleted. The exception is
   visual identity: [style-guide.md](style-guide.md) wins even over its
   neighbours here.
2. **A doc is part of the diff that changes its behaviour**, not a follow-up.
   Specs drifting from code is this repo's recurring failure mode — see
   [log/2026-08-29-phosphor-light-palette-reconcile.md](log/2026-08-29-phosphor-light-palette-reconcile.md)
   for what nineteen days of drift cost.

## Note on paths

This tree was `specs/` until 2026-08-30. Dated entries in [log/](log/) still
name files by their old paths, deliberately — they record what was true when
they were written. The mapping is:

| Was                | Is now                  |
| ------------------ | ----------------------- |
| `specs/reference/` | `docs/`                 |
| `specs/log/`       | `docs/log/`             |
| `specs/backlog/`   | `docs/specs/backlog/`   |
| `specs/build/`     | `docs/specs/build/`     |
| `specs/TRACKER.md` | `docs/specs/TRACKER.md` |
