# 08 — Sessions, Resume, Tree, Onboarding

## Lifecycle

- **New session**: spawn `pi --mode rpc` in workspace cwd, optional `-n <name>`; extension flags (`-e` artifacts) always applied.
- **Resume**: sidebar click on an on-disk session → spawn with `--session <path>`; hydrate chat from `get_messages`; rebuild artifacts by replay ([07-artifacts.md](07-artifacts.md)).
- **Concurrent sessions**: multiple live subprocesses per workspace; sidebar shows running state; switching is instant (stores keyed by sessionId).
- **Crash handling**: pi exit while streaming → toast + inline banner with one-click resume (session file survives). App quit → SIGTERM children.
- **Ephemeral option**: "scratch session" (--no-session) available but not default.

## Session operations (all in UI)

- Rename (`set_session_name`), pin (app prefs), delete (trash the .jsonl), export HTML (`export_html` → save dialog → reveal), session info popover (`get_session_stats`: message counts, tokens by class, cost, context %), fork (`get_fork_messages` picker or fork-from-message in chat → `fork`), clone (`clone`), switch (`switch_session` or new subprocess).
- `new_session`/`fork`/`clone` responses may be `cancelled` (an extension veto) — handle gracefully.

## Tree view (headline feature — pi TUI has /tree; Phosphor must do it better)

- Per-session interactive tree visualization built by parsing the session JSONL (`id`/`parentId`): nodes = user messages (primary), with tool/assistant entries collapsed between; current leaf highlighted; labels shown as bookmarks.
- Actions: jump/fork from any user message, clone branch, label/bookmark an entry (append `label` entry), preview any node's content on hover/click.
- Branch summaries (`branch_summary` entries) render as annotations on abandoned branches.
- Zoom/pan for large trees; keyboard navigable.

## Sidebar data (no processes needed)

- Scan `~/.pi/agent/sessions/--<mangled cwd>--/*.jsonl` per [02-pi-integration.md](../../pi-integration.md): header + last `session_info` + first user message + mtime; chokidar keeps it live. Cache parsed metadata (mtime-keyed) for fast startup.

## Onboarding & health

- **pi missing or < min version**: full-screen setup state with the install command (`npm i -g @earendil-works/pi-coding-agent`), re-check button, docs link.
- **No models available** (`get_available_models` empty): guide to authenticate — one-click "open terminal running `pi`" (built-in terminal, [06-terminal.md](../../terminal.md)) for `/login` OAuth flows, or point at env vars / `models.json` for API keys and local endpoints. Never handle or display secrets in Phosphor UI.
- Version drift note: warn (non-blocking) if pi minor version is newer than the last tested version.
