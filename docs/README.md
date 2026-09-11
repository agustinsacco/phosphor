# Phosphor documentation

**How Phosphor works today.** Every file here describes shipped behaviour. If
one disagrees with the code, the file is wrong, and fixing it is part of the
change that broke it.

One exception, and it is labelled: [known-issues.md](known-issues.md) describes
what is _broken_ rather than how something works.

Start with [overview.md](overview.md) for what Phosphor is, or
[architecture.md](architecture.md) for how the processes fit together.

## The system

| File                                   | Covers                                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| [overview.md](overview.md)             | Product definition, non-negotiables, engineering quality bar |
| [architecture.md](architecture.md)     | Process model, the IPC prefixes, cross-cutting requirements  |
| [pi-integration.md](pi-integration.md) | pi's RPC protocol and session format                         |

## The surfaces

| File                         | Covers                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| [ui-shell.md](ui-shell.md)   | Window chrome, top bar, sidebar, the pane system, theming  |
| [chat.md](chat.md)           | Transcript rendering, composer, tool cards, context meter  |
| [files.md](files.md)         | Explorer file management, transfers, clipboard, the editor |
| [terminal.md](terminal.md)   | PTY panes, clipboard, scrollback, per-session ownership    |
| [lanes.md](lanes.md)         | The lane row, PR status, naming, search, delete, reclaim   |
| [worktrees.md](worktrees.md) | Git worktree lifecycle and the branch control              |
| [settings.md](settings.md)   | The settings modal and which config file each tab writes   |

## What Phosphor talks to

| File                                 | Covers                                                      |
| ------------------------------------ | ----------------------------------------------------------- |
| [extensions.md](extensions.md)       | pi packages, the six bundled extensions, the status channel |
| [mcp.md](mcp.md)                     | MCP servers and connectors via the pi-mcp-adapter chain     |
| [cli-providers.md](cli-providers.md) | Running sessions on the Claude Code CLI                     |
| [updates.md](updates.md)             | Update detection, the three install paths, the macOS swap   |

## Visual identity

| File                             | Covers                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| [style-guide.md](style-guide.md) | Authoritative on all colour, type, voice and the mark's geometry |

## Three rules that keep this workable

1. **One fact, one home.** If a doc here and anything else disagree, this
   folder is right and the other file gets fixed or deleted. The exception is
   visual identity: [style-guide.md](style-guide.md) wins even over its
   neighbours here.
2. **A doc is part of the diff that changes its behaviour**, not a follow-up.
   Docs drifting from code is this repo's recurring failure mode.
3. **A rename is not a review.** A mechanical sweep touches the wrong lines as
   confidently as the right ones. If you edit this folder in bulk, read what
   you are changing.

## There is no history here

This folder is the present tense. **Git is the history**: `git log -p docs/`
answers "when did this change and why", and any deleted file is one
`git show <sha>:<path>` away. When you ship something, update the doc it makes
wrong, in the same diff. If you fix a defect in
[known-issues.md](known-issues.md), delete its row in that same diff.
