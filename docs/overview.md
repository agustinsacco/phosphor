# Phosphor — Product Overview

Phosphor is a desktop coding-agent app powered entirely by the **pi coding
agent** (`@earendil-works/pi-coding-agent`). It took its interaction vocabulary
from Claude Desktop's "Code" experience; the visual identity has since diverged
on purpose ([style-guide.md](style-guide.md)).

## Product definition

Coding only. No "normal chat" mode, no routines, no cloud sync. You open a
project folder, run agent sessions against it, and work beside the agent with a
file explorer, a code/diff viewer, a full terminal and an artifacts pane.

**Many sessions at once is the normal case.** A project usually has several
chats in flight, each on its own branch, and the product's job is to make that
legible. So the home screen is a lane board: every lane of the project in a
column named for what it needs from you, next to a ledger of what running them
all costs. Each session is still independent. There is no cross-session
manager, no orchestration agent, and the board spends nothing to render.

## Non-negotiables

1. **Coding first.** Every design decision optimizes for programming work.
2. **Rich responses are first-class.** Markdown, highlighted code, HTML
   previews, Mermaid, charts and math render inline, never as raw fences.
3. **YOLO execution.** pi runs in full-permission mode and **Phosphor ships no
   permission system of its own**: no gate, no allow-list, no invented
   confirmation. Tool calls run and stream results. The only thing that can
   stop one is a _user-installed_ permission-gate extension asking through
   `ctx.ui.select` / `confirm`, an ordinary `extension_ui_request` that rule 4
   obliges Phosphor to answer. `CommandApprovalSheet.tsx` renders those legibly
   ([extensions.md](extensions.md#command-approval-dialogs)); it decides
   nothing. Build the surface that shows someone else's gate honestly, never
   the gate.
4. **Feature-full.** Everything pi exposes ([pi-integration.md](pi-integration.md))
   is reachable from the UI. Even `/login`, which pi offers only as a TUI, is
   driven off-screen into a button and a browser tab
   (`electron/pi/login-flow.ts`; see [settings.md](settings.md)), with a hosted
   pi terminal as the escape hatch. Still unreached: `get_entries` /
   `get_tree`, mirrored in `shared/rpc.ts` and read by nothing yet.
5. **Claude Desktop craft level.** A light theme, a dark theme and "system",
   selectable in settings, sharing one component vocabulary.

## Visual & brand direction

**[style-guide.md](style-guide.md) is the authority.** Palette, type scale,
accent rules and the mark all live there. What survives here is intent:

- **Two themes, both first-class**, sharing one component vocabulary. Dark is
  never pure black.
- **Shape**: soft radii, 1px borders over shadows, generous but efficient
  spacing.
- **Motion**: quick and subtle. Streaming cursor, pane transitions, toast
  slides. Nothing bouncy.
- **Component vocabulary**: chips (folder, branch, model), stat tiles, pill
  toggles, collapsed tool cards with chevrons.
- Every state designed: empty, loading, error, "pi not installed".

## Engineering quality bar

- TypeScript strict everywhere; shared types for the IPC and RPC contracts.
- The RPC client is a small, well-tested library: framing, correlation, events,
  subprocess lifecycle, crash-restart with session resume.
- Graceful subprocess handling: a pi crash is a toast plus one-click resume
  (the session file survives); app quit SIGTERMs every child cleanly.
- Performance: virtualized chat list, debounced markdown re-parse, streaming
  without full-list re-render, 60fps pane dragging.
- CI: typecheck, lint, tests and e2e on every PR; a release workflow producing
  macOS, Linux and Windows builds plus the install script
  (`scripts/install.sh`).

## Reference material

- Technical docs: this folder, one living contract per surface, indexed by
  [README.md](README.md). Defects that still reproduce are in
  [known-issues.md](known-issues.md).
- pi's own docs, to verify before guessing pi behaviour:
  `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` (especially `rpc.md`,
  `session-format.md`, `settings.md`, `usage.md`, `extensions.md`, `skills.md`),
  `dist/modes/rpc/rpc-types.d.ts` for the exact protocol types,
  `dist/core/tools/*.d.ts` for tool schemas, and `examples/` for extension
  patterns.
