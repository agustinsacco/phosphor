# 07 — Artifacts

pi has no built-in artifacts (community packages `pi-artifacts` / `@jakeryderv/pi-artifacts` target TUI preview/publish workflows — not suitable). Phosphor ships its **own bundled pi extension**, a TypeScript file packaged with the app at `pi-ext/artifacts.ts`, loaded per-session via `pi --mode rpc -e <path>`.

## Extension design

- Registers two tools via `pi.registerTool()` (see `docs/extensions.md` and `examples/extensions/tools.ts` for the API):
  - `artifact_create` — params: `id?` (slug; generated if omitted), `title`, `type` (`html` | `markdown` | `svg` | `mermaid` | `code` | `chart`), `content`, `language?` (for `code`).
  - `artifact_update` — params: `id`, `content`, `title?`.
- Tool `execute` returns a short confirmation in `content` (keeps chat clean) and carries the full payload in `details` (`{id, title, type, language, content, version}`), which streams to the client via `tool_execution_end.result.details`.
- The extension maintains a per-session version counter per artifact id (in memory; recoverable by replay).
- The extension appends a concise system-prompt note (via the extension API's system-prompt hook) teaching the model **when** to use artifacts: substantial self-contained HTML/SVG/documents/diagrams/reports → artifact; small snippets → inline code block; update an existing artifact by id instead of re-creating.

## Renderer — Artifacts pane

- Artifact tool events populate the pane: **gallery list** per session (icon by type, title, version count, updated time) + **viewer**.
- Viewer: Code/Preview toggle using the same renderers as chat ([04-chat.md](../../chat.md)) — sandboxed iframe for html/svg, Mermaid, chart spec renderer, markdown, highlighted code.
- **Version history** per artifact id: version picker, Monaco diff between any two versions.
- Actions: copy content, save to file (dialog), export preview (PNG/SVG where applicable), open in Files pane as a real file.
- Pane opens automatically on a session's first artifact; badge on new versions.

## Persistence

- No separate store: artifacts replay from session history. On resume/attach, rebuild artifact state from `get_messages` (toolCall + toolResult pairs for `artifact_create`/`artifact_update`), same as live events. Verify tool results (with `details`) are present in the session JSONL on resume — they are (`toolResult` messages persist).

## Fallback

- Any chat code block has an "open as artifact" affordance that promotes it into the pane manually (client-side only; no model involvement).
