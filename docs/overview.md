# Phosphor — Product Overview

Phosphor is a desktop coding-agent app, powered entirely by the **pi coding agent** (`@earendil-works/pi-coding-agent`). It began as a study of Anthropic's Claude Desktop "Code" experience and took its interaction vocabulary from there; the visual identity has since diverged deliberately — see [style-guide.md](style-guide.md).

## Product definition

Coding-only. No "normal chat" mode, no routines, no cloud sync. The user opens workspaces (project folders), runs agent sessions against them, and works alongside the agent with a file explorer, code/diff viewer, full terminal, and an artifacts pane.

**Many sessions at once is the normal case, not the edge case.** A project
usually has several chats in flight, each on its own branch, and the product's
job is to make that legible rather than to pretend one session is the unit of
work. So the home screen is a lane board: every lane of the project in a column
named for what it needs from you, next to a ledger of what running them all
costs. Each session is still independent; there is no cross-session manager and
no orchestration agent, and the board spends nothing to render.

## Non-negotiables

1. **Coding first.** Every design decision optimizes for programming workflows.
2. **Rich responses are first-class citizens.** Markdown, syntax-highlighted code, HTML previews, Mermaid diagrams, charts, and math render beautifully inline in chat — never as raw text fences.
3. **YOLO execution.** pi runs in full-permission mode and **Phosphor ships no permission system of its own** — no gate, no allow-list, no confirmation Phosphor invented. Tool calls execute and stream results, period. Do not build one. The only thing that can stop a tool call is a _user-installed_ permission-gate extension, which asks through `ctx.ui.select` / `confirm` — an ordinary `extension_ui_request` that non-negotiable 4 obliges Phosphor to answer. `src/features/extension-ui/CommandApprovalSheet.tsx` renders those legibly instead of dumping a 4000-character heredoc into a dialog title (see [extensions.md](extensions.md#command-approval-dialogs)); it decides nothing and adds no gate of its own. Build the surface that shows someone else's gate honestly, never the gate.
4. **Feature-full.** Everything pi exposes (see [pi-integration.md](pi-integration.md)) is reachable from the UI. Even `/login`, which pi offers only as a TUI screen, is driven off-screen into a button and a browser tab (`pi:startLogin` → `electron/pi/login-flow.ts`; see [settings.md](settings.md)), with a hosted pi terminal (`pi:loginTerminal`) as the escape hatch for a provider that driver cannot answer. What is left unreached is `get_entries` / `get_tree`: mirrored in `shared/rpc.ts`, read by nothing yet.
5. **Claude Desktop craft level.** Warm off-white light theme, comfortable dark theme, selectable in settings (plus "system").

## Visual & brand direction

**[style-guide.md](style-guide.md) is the authority — read it, not this section.**
The palette, type scale, accent rules and mark all live there.

What survives here is only the product-level intent that the style guide then
implements:

- **Two themes, both first-class**: a warm paper light theme and a warm dark
  theme (never pure black), sharing one component vocabulary.
- **Shape**: soft radii, subtle 1px borders preferred over shadows, generous
  but efficient spacing.
- **Motion**: quick and subtle — streaming cursor, pane transitions, toast
  slides. Nothing bouncy.
- **Component vocabulary**: chips (folder, branch, model), stat tiles, pill
  toggles, collapsed tool cards with chevrons.
- Every state designed: empty states, loading skeletons, error states, "pi not
  installed" state.

> **Superseded 2026-08-07, corrected here 2026-08-27.** This section used to
> specify a terracotta/coral accent and a serif display face, both copied from
> Claude Desktop. The Phosphor restyle (P10) replaced the accent with amber
> phosphor and retired serif from the brand voice; `src/` and `electron/` carry
> zero terracotta hexes. The old text sat here contradicting the style guide
> for 20 days, which is exactly the trap this file must not set.

## Engineering quality bar

- TypeScript strict everywhere; shared types for IPC + RPC contracts.
- The RPC client is a small, well-tested library (framing, correlation, event emitter, subprocess lifecycle, crash-restart with session resume).
- Graceful subprocess handling: pi crash → toast + one-click resume (the session file survives); app quit → clean SIGTERM to all children.
- Performance: virtualized chat list, debounced markdown re-parse, streaming without full-list re-render, 60fps pane dragging.
- Tests: unit tests for RPC framing edge cases (U+2028 inside JSON strings, CRLF, chunk splits mid-line), session-file parser, diff reconstruction; Playwright-for-Electron smoke e2e (open workspace → new session → prompt → streamed response → edit diff renders → artifact renders).
- CI: GitHub Actions — typecheck, lint, test on PR; release workflow producing builds for macOS/Linux/Windows + the install script ([10-packaging.md](specs/build/10-packaging.md)).

## Reference material

- Spec docs: this folder. Execution order and status: [TRACKER.md](specs/TRACKER.md).
- pi local docs (verify against these before guessing pi behavior):
  `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` — especially `rpc.md`, `session-format.md`, `settings.md`, `usage.md`, `extensions.md`, `skills.md`
  `$(npm root -g)/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts` — exact protocol types
  `$(npm root -g)/@earendil-works/pi-coding-agent/dist/core/tools/*.d.ts` — tool input/details schemas
  `$(npm root -g)/@earendil-works/pi-coding-agent/examples/` — extension patterns, `rpc-extension-ui.ts`
