# 04 — Chat: Composer, Streaming, Rich Rendering

The transcript shows the work, not just the answer: text streams, thinking has
its own block, tool calls become steps you can open, an edit shows its diff.
The composer is one small field with several ways in.

## Composer

- Multi-line. Enter sends, Shift+Enter newline. IME confirmation keys never
  send.
- **Markdown list primitives.** Shift+Enter continues the list the caret is on
  (renumbering; an empty item steps out a level, then exits). Tab/Shift+Tab
  nest and un-nest inside a list. Cmd/Ctrl+Shift+8 and +7 toggle bullet and
  numbered, Cmd/Ctrl+B and +I wrap, Cmd/Ctrl+Shift+C fences. **Enter always
  sends**; continuation is deliberately not on it, or a one-line prompt starting
  with `- ` would stop sending. Logic in `src/lib/composerText.ts`; keymap in
  `composer/ComposerField.tsx`, shared by both composers.
- **Formatting is keyboard-only**: bold, italic, inline code (Cmd/Ctrl+E), code
  block, lists and links (Cmd/Ctrl+Shift+K). No toolbar. Edits go through
  Chromium's `insertText`, so native Undo/Redo works.
- **Long prompts:** Cmd/Ctrl+Shift+X opens the field to half the window height
  without losing selection or draft. It stays a Markdown textarea, not a
  WYSIWYG editor.
- Sent user messages render list runs as real lists. Deliberately not a full
  markdown renderer; the bubble also carries the `<attached-files>` block.
- **While streaming**: Enter queues a **steering** message (delivered after the
  current tool calls), Alt/Cmd/Ctrl+Enter queues a **follow-up** (after the
  agent finishes). Same semantics as pi's TUI; the two queues look different.
  Escape aborts and hands queued messages back to the composer. Once the draft
  has text, **Steer now** and **Queue follow-up** buttons expose both without
  a keyboard.
- Queued chips render above the composer, each with a ✕ that undoes just that
  entry. pi has no per-entry command, so `composer/queueActions.ts` drains with
  `clear_queue` (pi 0.84.4+; refused on older pi) and re-queues the survivors.
- `@` → fuzzy file search across the workspace (gitignore-aware), inserts a
  path reference.
- Images: paste or drag → thumbnails → sent as `images[]` with the prompt.
- **Drafts persist.** Text, attachments and the model the draft was composed
  against live in `src/stores/drafts.ts`, keyed per session or per home
  workspace, and survive switching and quitting. Image bytes go to
  `userData/drafts/`, never into prefs.
- The model chip has an explicit loading state; an empty list before the
  catalogue answers is never shown as "no models configured".
- `!command` → RPC `bash` (output in chat, enters model context on the next
  prompt). `!!command` → same with `excludeFromContext: true` and a "not sent
  to model" badge.
- `/` → command menu fed by `get_commands` (extension commands, prompt
  templates, `skill:*`, with source badges) merged with exactly **three**
  Phosphor-native ones: `/compact`, `/export`, `/name`. Everything else is
  pi's, so the list grows by installing an extension. An unknown `/x` still
  goes to pi as a prompt.
- Composer widget slots above/below for extension `setWidget`;
  `set_editor_text` prefills the input.

## Streaming rendering rules

- Deltas reduce incrementally into per-message view-models. The list is never
  rebuilt per delta.
- **Text** renders as live markdown. A fenced block renders its rich form only
  once the fence closes (plain mono while open), to avoid flicker.
- **Thinking** streams into a collapsed-by-default block, subdued, expandable
  during and after. Respects pi's `hideThinkingBlock`.
- **Tool calls** appear as cards at `toolcall_start`, args fill from deltas,
  live output attaches via `tool_execution_update`, final state at
  `tool_execution_end`.
- Virtualized list; 1000+ entries stay smooth. Autoscroll, with a "jump to
  bottom" pill when you scroll up.
- **Following the tail is one-way from geometry.** A scroll sample can stop the
  follow, never start it: a transcript that shrinks (an activity group
  collapsing) clamps `scrollTop` to the tail, which looks identical to a reader
  who chose the bottom. Following resumes only on a gesture: wheel or keys
  toward the tail, the pill, or sending a message.
- **A reader who scrolled away keeps their place through any layout change.**
  While unpinned, the content box is floored at the reader's viewport bottom,
  so a shrink reserves empty space below the last row instead of dragging them
  down.

## Message affordances

- Copy message: the raw markdown of the WHOLE turn, even from the pill on one
  prose block. That is what "copy the answer" means when a turn interleaves
  text and tool calls.
- Code blocks carry three hover actions (`components/markdown/CodeBlock.tsx`):
  **Open as artifact** (typed from the language: html/svg/mermaid/chart/
  markdown, else `code`), **Run in terminal** (shell languages only; pastes
  without executing) and copy.
- User messages: **Rewind to here**, plus a branch button opening the
  multi-message rewind picker (Esc Esc). Both run pi's `fork` RPC
  (`features/chat/rewind.ts`), which branches the live session onto a **new
  session file** rooted just before that entry and hands the original text
  back to the composer. `bootstrapSession` re-runs to learn the new file path.
  Attachments are restored from the transcript, since `fork` replies with text
  only.
- Error and abort stop reasons are styled apart: an error banner with the
  message; aborted is a muted "stopped" divider.
- Auto-retry: an inline strip "Retrying (2/3) in 4s — <error>" with cancel.
- Compaction: a system divider "Context compacted — N tokens summarized" with
  an expandable summary.

## Tool renderers

| Tool               | Treatment                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`             | Collapsed file chip: path, line range, size; click opens the file in Files pane. Returned images render inline                                                                                             |
| `bash`             | Terminal-styled block, streaming output, exit-code badge, duration; truncation notice names `fullOutputPath` (text, not a link)                                                                            |
| `edit`             | Proper diff from `details.diff`/`details.patch` — green/red gutters, collapsed beyond ~40 lines, header shows path + hunk stats, click opens file at `details.firstChangedLine`; feeds Files Changed panel |
| `write`            | "Created/Overwrote <path>" chip + collapsible content preview (highlighted)                                                                                                                                |
| `grep`/`find`/`ls` | Compact result lists, match counts, truncation notices; rows click through to files                                                                                                                        |
| unknown/extension  | Generic: tool name, collapsed pretty-JSON args, streaming output area, error state. Must look polished with zero special-casing                                                                            |

### Blocks from the Claude Code provider

Sessions on `@saccolabs/pi-claude-cli` carry three shapes no pi-native provider
produces. All are handled in `items/transcriptRows.ts`, so tool-UX work
inherits them; anything that re-derives rows from `AssistantBlock`s must handle
them again.

| Shape                                       | Where it comes from                                                                                                                                                             | Treatment                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[Claude Code · Name {args}]` text block    | Tools Claude Code ran **inside its own process** (WebSearch, WebFetch, ToolSearch, the user's MCP servers, sub-agents). pi cannot execute them, so they are never pi tool calls | Parsed into an `externalTool` activity step: grouped with pi's tools, counted in the summary, never markdown-rendered                                              |
| `[Claude Code · result #<id> {…}]`          | The outcome of one of those calls. Phosphor asks for these with `PI_CLAUDE_CLI_TOOL_RESULTS=1`, which also makes the call marker carry `#<tool_use_id>`                         | Folded into the row its call produced — **never a row of its own**. Gives that row a live state, an outcome line, a failure state and an expandable output preview |
| thinking block with a signature and no text | Encrypted thinking (fable-5, opus-5, sonnet-5; haiku-4-5 sends plaintext)                                                                                                       | Skipped on settled items. Provider ≥0.4.4 stops emitting them, but sessions recorded earlier are on disk forever                                                   |

The marker strings are a **cross-repo wire contract**, documented on the
emitting side. A result payload is complete JSON and parsed strictly; a payload
that does not parse leaves the row settled with no outcome rather than an
invented one. The call marker's argument preview is complete JSON only on
provider ≥ 0.8.0; below that it is cut at 120 characters, so `externalToolInfo`
reads it **best-effort only** to pick a headline. `Agent`/`Task` markers fold
into `subagent` steps, one per agent (three markers describe each), and feed
the composer's sub-agent strip. **A sub-agent row's status claims only what its
markers prove**: `launched` until the CLI confirms a start, no completion until
one is reported. Its live step and running cost come from the
`claude-subagents` status channel, joined by `taskId`
([extensions.md](extensions.md#how-provider-transcripts-render)). Nothing may
ever _depend_ on the preview parsing: a marker with unreadable args still
renders as a plain named step.

## Rich content (first-class citizens)

- GFM (`remark-gfm`): headings, tables (hover → Copy MD / Copy CSV), task
  lists, footnotes, autolinks, blockquotes. GitHub's `[!NOTE]` syntax is not
  special-cased.
- Code: Shiki, language badge, the three hover actions, horizontal scroll
  contained in the block. One highlighter carries both themes, so a theme
  switch re-paints from CSS variables and never re-highlights. Unknown
  languages load on demand and fall back to plain text.
- ` ```mermaid ` → diagram in the Phosphor palette, re-rendered on theme
  change. Click opens a full-width scrollable lightbox (click or Escape to
  close). No pan/zoom, no export. A parse error falls back to the code block
  with the error under it.
- ` ```chart ` (a Chart.js config) and ` ```vega-lite ` → theme-aware chart;
  invalid specs fall back to the code block with the error.
- ` ```html ` → Code/Preview toggle. The preview is
  `<iframe sandbox="allow-scripts" src=…>`, **`src`, never `srcdoc`**: a
  srcdoc document inherits the app's CSP, which refuses every inline script
  and makes the sandbox attribute a no-op. The HTML is staged in main and
  **served** over `phosphor-artifact://` under its own `default-src 'none'`
  policy: inline script and style allowed, `data:`/`blob:` media allowed, no
  `connect-src`, no remote images, no `form-action`. `allow-same-origin` is
  absent, which keeps the origin opaque. Net: the document gains scripting and
  loses all network reach (`components/SandboxedHtml.tsx`,
  `electron/artifacts/artifact-protocol.ts`).
- KaTeX for `$…$` / `$$…$$`.
- Images inline with click-to-zoom.
- **Links split by what they point at** (`components/markdown/MarkdownLink.tsx`).
  An `http(s)` URL opens in the default browser. A path (`docs/chat.md`,
  `./README.md`, `/abs/path`, `file://`) opens in the **Files pane** at the
  line it names (`#L42` or `:42`); an unreadable path toasts. A file link
  renders with no `href`, so no click can navigate the window away. Other
  schemes do nothing.

## Session controls (per session)

The model chip, thinking chip and context meter live in the **composer
footer** (`Composer.tsx`, right of the attach button); the session's ⋮ menu is
in the **top bar** (`app/TopBar.tsx` → `SessionMenu`).

- **Model picker** (from `get_available_models`), grouped by **family** by
  default so every route to one model sits under one header, toggleable to
  provider grouping, with `provider:`/`id:`/`name:`/`is:` search qualifiers,
  starred and recent rows. Custom and local providers are listed too.
- **Thinking-level selector**: pi has **seven** levels, `off` → `max`. Which
  ones a model offers is per model: a non-reasoning model has only `off`,
  `xhigh`/`max` are opt-in. A live session asks pi
  (`get_available_thinking_levels`); the home picker derives the same answer
  from `shared/thinking.ts`. The chip is hidden unless the model has more than
  one level.
- **Two owners, one chip.** `ModelPicker` drives a live session over RPC
  (`set_model`). `HomeModelPicker` has no process to talk to, so it reads and
  writes pi's own `defaultProvider` / `defaultModel` / `defaultThinkingLevel`.
  Both render `composer/ModelChip.tsx`, which owns the layout and the rule
  that only a non-pi provider gets named.
- **Context meter**: % of window from `get_session_stats` (polled after each
  `agent_end` and on demand), warn state near the compaction threshold, and
  the popover below.
- **Stop** (`abort`) is the send button while a turn runs. Everything else is
  in the ⋮ menu: Export HTML…, Compact now… (optional custom instructions),
  auto-compaction, auto-retry, and the two queue-mode rows (Steering /
  Follow-ups, "All at once" / "One at a time", cycled in place). Toggles keep
  the menu open. Renaming is `/name` or the sidebar row.

### Streaming text is paced, not rendered per delta

Delta granularity is a provider property. The Claude Code provider batches
prose into ~90-character chunks half a second apart, where pi-native providers
send token-sized deltas tens of milliseconds apart. Rendering each chunk on
arrival lands Claude turns in slabs.

So the visible text is a paced slice of the store's exact text: `useSmoothedText`
(leaf-local, per prose block) drains the backlog at a rate proportional to its
size, aiming to empty it in about one upstream gap. `src/lib/textReveal.ts`
holds the pure math. Rules:

- **The store is never touched.** Pacing lives in the one streaming block;
  `buildTranscriptRows` does not re-run per tick; commits are capped near 30Hz
  because each one re-parses that block's markdown.
- **Mount shows everything already present.** History and virtualizer
  re-mounts never replay a typewriter.
- **Settling drains fast instead of snapping**, so a turn does not end with
  one final pop.
- **rAF has a timeout backstop**, so hidden windows still complete the text.
- `prefers-reduced-motion` disables the reveal.

### What the context meter's popover shows

Five sources, three confidence levels, and the UI keeps them distinguishable
because they are not equally trustworthy.

| Section                 | Source                                                         | Shown for                         |
| ----------------------- | -------------------------------------------------------------- | --------------------------------- |
| Tokens / cost           | `get_session_stats`                                            | every session                     |
| Context composition     | `phosphor-context-breakdown` status key (bundled extension)    | every session                     |
| Optimization · Headroom | `phosphor-headroom` status key (bundled extension)             | sessions that compressed a result |
| Plan usage              | `claude:usageSnapshot` IPC — `claude -p /usage`, live percents | Claude Code provider sessions     |
| Plan limits             | `claude-rate-limit` status key (provider ≥0.4.5)               | Claude Code provider sessions     |

**Wide, not tall.** The popover anchors upward from the composer, so a tall
stack clips its own heading off the top of the window. It is 27rem wide, with
the composition legend, Tokens/Session and the plan windows each in a row, and
its body scrolls as a backstop. Adding a section means finding it a column.

**The meter must not close.** It renders whenever the session has stats, and
draws the ring unfilled with a `—` when the percentage is briefly unknown
(which is exactly what pi reports from a compaction until fresh usage
arrives). It is the only door to the four sections below, and the plan-usage
fetch only runs when the popover opens. Plan usage likewise always renders a
row: `Checking…`, then the windows, or the one-line reason there are none. A
section that disappears on failure is indistinguishable from a fetch that
never happened.

**Not every provider reports usage while it streams.** `src/lib/liveStats.ts`
takes the context estimate from the newest true reading: the streaming message
when its deltas have reported anything, else the last message to have
**ended** since the last poll. The OpenAI Responses API (`openai-codex`) fills
usage only on its terminal event, so its mid-turn frames carry a
present-but-zeroed usage object; without the fallback a whole turn read 0%.
`message_end` carries authoritative usage on every provider, so the fallback
costs no round trips.

**Context composition** answers "full of _what_": messages, system prompt,
tool schemas, MCP tool schemas. pi's single `contextUsage.tokens` cannot say
that. Only the **total is authoritative**: component sizes are character-based
estimates (no tokenizer is reachable from an extension), labelled approximate,
and free space is the honest remainder.

`breakdownSlices` scales estimates **down** to fit pi's total and never up. The
extension can only measure pi's own state, and under a CLI provider that is a
minority of the request: the Claude CLI sends its own system prompt and native
tool schemas and keeps native tool results in its own transcript. That
remainder is its own **Unmeasured** slice. Never fold provider-side context
into a row that names something else, and never let the parts sum past the
total. An absurd total or a dominant Unmeasured slice is evidence about the
provider's `totalTokens`, not about the estimate.

**MCP servers** breaks the MCP slice down per connector, as chips (name +
tokens), because a single slice cannot say which server to disconnect. Under
the gateway that is **one proxy tool per server** (`mcp__<server>`, ~700
tokens); the server's own tools are fetched on demand and never carried in
context. A server with `directTools` is the exception: every schema lands in
the window, and its chip goes from hundreds of tokens to tens of thousands
([mcp.md](mcp.md#the-claude-provider-reaches-mcp-through-pi-not-around-it)).

**Plan usage vs Plan limits** answer different questions and are never merged.
**Plan usage** is the always-on percent per window (5-hour, weekly, per-model
weekly), the same numbers the CLI's `/usage` and Claude Desktop show, fetched
live (no quota, no key) when the popover opens and cached ~60 s in main
(`electron/claude/usage.ts` parses the CLI's rendered text; a parse that yields
nothing hides the section). **Plan limits** is the binding constraint as the
provider relays it mid-turn: one window, only once the CLI's warning threshold
has crossed, but the only source that can say "capped now" between turns.
All-day percent: Plan usage. The wall: Plan limits.

**Plan limits** is account state, not session state: the window, when it
resets, whether the account is capped or on overage, and (provider ≥ 0.4.9)
how much of the window is consumed. Older providers send no percentage, so the
bar is omitted rather than guessed; `utilization: null` and "none used" never
look the same. It renders only when the key is present.

**Plan usage** renders one dial per window (arc, percent, window name, a
compact countdown). **Refresh** re-runs `claude -p /usage` past main's cache.

It reads the lane's OWN account (`claude:sessionAccount` →
`claude:usageSnapshot <id>`) and names it once more than one Claude login is
configured. Asking without an id read whichever credential the CLI keeps by
default, which on a multi-account install is routinely a different plan than
the lane is spending. **Switch account** lists every other signed-in login and
moves this lane to the one picked, held accounts included and marked. The move
is a respawn, not a switch: a running lane's credential was fixed at spawn, so
the lane is disposed and resumed from its session file against the new
account, and the next turn re-reads the whole thread.

This is the one figure on the popover that comes from the account rather than
from a token count, which makes it the one to trust when they disagree.

Crossing the CLI's warning threshold (≥75% utilized, or a hard cap) also opens
a dismissible banner above the composer (`composer/RateLimitBanner.tsx`), gated
by the same `needsAttention` the popover's colouring uses, so the two surfaces
cannot disagree about what counts as urgent. It goes quiet once a fresh event
reports a healthy percentage or `resetsAt` has passed. A dismiss is keyed to
the exact reading shown, so a later, worse event reopens it.

Both keys arrive through pi's extension-UI status channel into
`stores/extensionUi.ts`, keyed by session. `composer/contextBreakdown.ts` and
`composer/rateLimit.ts` each return `null` for a missing or malformed payload,
so a bad push degrades to "section absent" rather than a broken meter.
