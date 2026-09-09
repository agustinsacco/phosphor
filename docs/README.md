# Phosphor documentation

**How Phosphor works today.** Every file here describes shipped behaviour. If
one disagrees with the code, the file is wrong and fixing it is part of the
change that broke it.

There is one exception, and it is labelled: [known-issues.md](known-issues.md)
describes what is _broken_ rather than how something works.

Start with [overview.md](overview.md) for what Phosphor is, or
[architecture.md](architecture.md) for how the processes fit together.

## The system

| File                                   | Covers                                                           |
| -------------------------------------- | ---------------------------------------------------------------- |
| [overview.md](overview.md)             | Product definition, non-negotiables, engineering quality bar     |
| [architecture.md](architecture.md)     | Process model, the 17 IPC prefixes, cross-cutting requirements   |
| [pi-integration.md](pi-integration.md) | pi's RPC protocol and session format — the load-bearing document |

## The surfaces

| File                         | Covers                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| [ui-shell.md](ui-shell.md)   | Window chrome, top bar, sidebar, the pane system, theming  |
| [chat.md](chat.md)           | Transcript rendering, composer, tool cards                 |
| [files.md](files.md)         | Explorer file management, transfers, clipboard, the editor |
| [terminal.md](terminal.md)   | PTY panes, clipboard, scrollback, per-session ownership    |
| [lanes.md](lanes.md)         | The lane board, lane state, and the ledger                 |
| [worktrees.md](worktrees.md) | Git worktree lifecycle and the branch control              |
| [settings.md](settings.md)   | The settings modal and which config file each tab writes   |

## What Phosphor talks to

| File                                 | Covers                                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| [extensions.md](extensions.md)       | The six bundled pi extensions; the status-channel contract |
| [mcp.md](mcp.md)                     | MCP servers and connectors via the pi-mcp-adapter chain    |
| [cli-providers.md](cli-providers.md) | Running sessions on external CLI providers (Claude Code)   |
| [updates.md](updates.md)             | Update detection, the three install paths, the macOS swap  |

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
   Docs drifting from code is this repo's recurring failure mode. It once cost
   nineteen days of a style guide describing a warm "bone paper" light theme
   after an unrelated commit had re-based every light neutral to cool grey —
   half the tokens wrong, with the terminal and editor still rendering warm
   inside a cool app, and nobody able to tell which half to trust.
3. **A rename is not a review.** In September 2026 a find-and-replace rewrote
   every file in this folder. It touched the exact lines that were wrong and
   left every one of them wrong, which made the whole folder read as freshly
   maintained — thirty false claims survived it, and it corrupted three
   status-channel keys that are unchecked string literals. A doc whose last
   commit is a mechanical sweep has not been verified. If you are editing this
   folder in bulk, read what you are changing.

## There is no history here

This folder is the present tense. It carried 161 dated write-ups and a specs
tree of already-built plans until 2026-09-09; both were deleted, because a
reader could no longer tell a living contract from a finished plan, and the
finished plans were the larger pile. **Git is the history** — `git log -p docs/`
answers "when did this change and why", and any deleted file is one
`git show <sha>:<path>` away.

What that means in practice: when you ship something, update the doc it makes
wrong, in the same diff. Do not add a dated entry describing what you did. If
you fix a defect listed in [known-issues.md](known-issues.md), delete its row
in that same diff — the code becomes the record.
