# Phosphor documentation

**How Phosphor works today.** The living contracts describe current behaviour.
If one disagrees with the code, the file is wrong, and fixing it is part of the
change that broke it.

Two labelled exceptions: [known-issues.md](known-issues.md) describes current
defects; [future-features.md](future-features.md) holds decided or explored
directions that are not built. A feature moves into its surface's living doc
and leaves the future file in the same diff that builds it.

For installation and task-oriented tutorials, start with the
[Phosphor guides](https://phosphor.saccolabs.com/guides/): first task, daily work,
[multi-agent work and Swarm](https://phosphor.saccolabs.com/guides/swarm/),
subscriptions and accounts, pi extensions, and MCP connectors. These guides explain
how to use the UI; the contracts below own the technical behavior.

Start with [overview.md](overview.md) for what Phosphor is, or
[architecture.md](architecture.md) for how the processes fit together.

## The system

| File                                   | Covers                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| [overview.md](overview.md)             | Product definition, non-negotiables, engineering quality bar            |
| [architecture.md](architecture.md)     | Process model, the IPC prefixes, cross-cutting requirements             |
| [desktop-build.md](desktop-build.md)   | Desktop paths, native install ownership and packaging                   |
| [installations.md](installations.md)   | Dependency domains, scoped source closure and bundling                  |
| [nx-cache.md](nx-cache.md)             | Local check cache inputs, exclusions and task resource bounds           |
| [pi-integration.md](pi-integration.md) | pi's RPC protocol and session format                                    |
| [host.md](host.md)                     | Host CLI, machine identity, environment, checks and acceptance sessions |
| [remote-access.md](remote-access.md)   | Remote foundations, trust boundary and local validation                 |
| [control-plane.md](control-plane.md)   | Site and account API server, authentication ports and configuration     |

The remote foundations do not enable remote execution. Host enrollment commands,
Desktop approval clients, the control server's enrollment, machine and Host
routes and their database functions exist. The server is not deployed yet.
The Host checks a machine and runs local acceptance sessions; it has no listener.

## The surfaces

| File                         | Covers                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| [ui-shell.md](ui-shell.md)   | Window chrome, top bar, sidebar, the pane system, theming           |
| [chat.md](chat.md)           | Transcript rendering, composer, tool cards, find, context meter     |
| [files.md](files.md)         | File management, transfers, clipboard, search in files, the editor  |
| [terminal.md](terminal.md)   | PTY panes, clipboard, scrollback, per-session ownership             |
| [routines.md](routines.md)   | Local scheduled lanes, run history, catch-up, and unattended access |
| [lanes.md](lanes.md)         | The lane row, PR status, naming, search, delete, reclaim            |
| [worktrees.md](worktrees.md) | Git worktree lifecycle and the branch control                       |
| [settings.md](settings.md)   | The settings modal and which config file each tab writes            |
| [feedback.md](feedback.md)   | In-app rating and feedback, filed as a labelled GitHub issue        |
| [voice.md](voice.md)         | Dictation with a local speech model: download, processes, privacy   |

## What Phosphor talks to

| File                                         | Covers                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [extensions.md](extensions.md)               | pi packages, the seven bundled extensions, the status channel        |
| [mcp.md](mcp.md)                             | MCP servers and connectors via the pi-mcp-adapter chain              |
| [cli-providers.md](cli-providers.md)         | Running sessions on the Claude Code CLI                              |
| [provider-symmetry.md](provider-symmetry.md) | What native and Claude sessions share, how they differ, how to check |
| [updates.md](updates.md)                     | Update detection, the three install paths, the macOS swap            |

## Visual identity

| File                             | Covers                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| [style-guide.md](style-guide.md) | Authoritative on all colour, type, voice and the mark's geometry |

## Exceptions

| File                                     | Covers                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [known-issues.md](known-issues.md)       | Defects that reproduce today                                      |
| [future-features.md](future-features.md) | Decided or explored directions, dependencies, questions and risks |

## Three rules that keep this workable

1. **One fact, one home.** Each living doc owns its surface; other copies link
   here rather than competing. If a doc disagrees with code, fix the doc.
   For visual identity, [style-guide.md](style-guide.md) wins over its neighbours.
2. **A doc is part of the diff that changes its behaviour**, not a follow-up.
   Docs drifting from code is this repo's recurring failure mode.
3. **A rename is not a review.** A mechanical sweep touches the wrong lines as
   confidently as the right ones. If you edit this folder in bulk, read what
   you are changing.

## There is no history here

The living contracts are present tense. **Git is the history**: `git log -p docs/`
answers "when did this change and why", and any deleted file is one
`git show <sha>:<path>` away. When you ship something, update the doc it makes
wrong, in the same diff. If you fix a defect in
[known-issues.md](known-issues.md), delete its row in that same diff.
