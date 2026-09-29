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
  templates, `skill:*`) merged with exactly **three** Phosphor-native ones:
  `/compact`, `/export`, `/name`. Everything else is pi's, so the list grows by
  installing an extension. An unknown `/x` still goes to pi as a prompt.
  - **Every command is listed** — the popup scrolls; there is no cap. (A cap
    of 12 hid every skill behind the extension commands until 2026-09-16.)
  - **Filtering happens once**, in `useSlashMenu`; `CommandMenu` renders the
    array it is given. The highlighted row and the row Enter picks are the same
    element by construction.
  - **Search** (`commandScore` in `src/lib/fuzzy.ts`) ranks exact name, then
    name prefix, then a whole segment (`/debug` → `skill:debug`), then a
    segment prefix (`/mcp` → `pi-mcp`), then a subsequence, then a substring of
    the description (`/status` → "Show MCP server status"). `:` is a word
    boundary. Nothing typed: grouped Phosphor / Extensions / Prompts / Skills
    with section headers, pi's registration order within a group.
  - **Every row says where it comes from** (`commandCatalogue.ts`): pi's
    `sourceInfo` becomes a short origin — the package name (`pi-web-access`),
    `built into pi` for pi's inline extensions, `project · .claude/skills` for a
    local skill — and the tooltip carries the whole description, the file
    path and any aliases.
  - **Aliases fold.** Two commands from the same file with the same description
    are one row (pi-mcp-adapter's `/mcp` + `/pi-mcp`); the alias stays
    searchable and is named in the tooltip. Matching is on payload equality,
    never on a hardcoded name.
  - **MCP prompts are badged PROMPT**, not EXTENSION, and their origin names
    the server (`notion · MCP prompt`), detected from the adapter's
    `mcp__<server>__<prompt>` naming.
  - **`/mcp-auth` is demoted**: not in the browse list, still found when typed,
    described with a pointer to Settings ▸ MCP Connectors (which drives it —
    see [mcp.md](mcp.md#settings--connectors) for why a hand-run flow is the
    dangerous one).
  - **The list stays fresh.** Main broadcasts `pi:commandsChanged` after a
    package install/remove/update, an mcp.json write, a skill mutation or a pi
    sign-in; the renderer drops the home composer's per-folder cache and
    re-issues `get_commands` on every live session. The chat composer also
    re-asks its own session on `/`, throttled to once per 30 s, which is what
    catches an in-chat `/mcp reconnect`. A live pi does not load a newly
    installed extension until it restarts, so for packages only the home
    composer changes.
  - **The menu never silently vanishes.** With nothing to list it shows why:
    loading (the home probe spawns a pi), pi unreachable (with the reason from
    `pi:commands`' `error`), or no match — in which case Enter is not consumed
    and sends the text to pi as a prompt, as the row says.
  - Not possible today: argument completion (`/mcp ⇥` → `reconnect`,
    `tools`, …). pi-mcp-adapter defines `getArgumentCompletions`, but pi's RPC
    exposes no command for it.
- Composer widget slots above/below for extension `setWidget`;
  `set_editor_text` prefills the input.

## Streaming rendering rules

- Deltas reduce incrementally into per-message view-models. The list is never
  rebuilt per delta.
- **Text** renders as live markdown. A fenced block renders its rich form only
  once the fence closes (plain mono while open), to avoid flicker.
- **Thinking** is one quiet row per run of reasoning, above the step it
  preceded (`ThoughtRow` in `ActivityGroup.tsx`, text helpers in
  `features/chat/thoughts.ts`). Collapsed by default, expandable during and
  after; respects pi's `hideThinkingBlock`.
  - **While it streams**, the group's line reads "Thinking 8s · <headline>"
    and the row shimmers the newest sentence, so the two lines never repeat
    each other. The headline is the latest section title for Codex (its
    summaries open each section with `**Title**`) or the first sentence of
    the latest paragraph for prose (Claude).
  - **Once it ends**, the row reads "✳ Thought for 12s · <first headline>" and
    the group's line adds "thought for 41s" in total.
  - **Timing is local.** The reducer stamps `startedAt`/`endedAt` on a
    thinking block as it streams and carries them through `message_end`. pi's
    session file records none, so history shows "Thought" and "N thoughts".
  - Every thought has a row, including reasoning before a Claude Code tool or
    a sub-agent, which the old hover-only gutter mark could not show. Thinking
    with no text (a signature only) has nothing to open.
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
  The entry comes from the session's **current branch** (`get_entries` walked
  from its `leafId`, `currentBranchUserMessages`). The button matches its row
  to an entry by the message's own timestamp, never by position: the
  transcript is pi's compaction-aware context, while `get_fork_messages` spans
  every branch in the file and skips image-only messages, so the Nth of one is
  not the Nth of the other. When no entry matches for certain, the button
  refuses ("Could not locate this message to rewind.") rather than fork from a
  guess. The picker lists the same current-branch messages, including those a
  compaction summarised away. Attachments are restored from the entry, since
  `fork` replies with text only.
- Error and abort stop reasons are styled apart: an error banner with the
  message; aborted is a muted "stopped" divider.
- Auto-retry: an inline strip "Retrying (2/3) in 4s — <error>" with cancel.
- Compaction: a system divider "Context compacted — N tokens summarized" with
  an expandable summary, drawn from pi's `compaction_end` on every provider,
  Claude Code included ([cli-providers.md](cli-providers.md#compaction-has-one-owner)),
  whether pi compacted at its own threshold or at the
  [context budget](cli-providers.md#one-context-budget).
  Sessions recorded on provider 0.8.3–0.8.x also carry its
  `[Claude Code · compact {…}]` marker, emitted when the CLI compacted its own
  session mid-turn, and draw the same divider there. It records that old cut
  only: from 0.9.0 the provider replays pi's whole context, so the model holds
  both sides of it again. The marker is its own row, never folded into an
  activity group.

## Find in a session

Cmd/Ctrl+F from the composer or anywhere in the chat opens a find bar over the
transcript. It counts every match in the session, not only the rows on screen.
The transcript is virtualized, so `features/chat/transcriptFind.ts` reduces
each row to the text it renders as and counts that. Tool output, reasoning and
the steps of a collapsed run count too, and stepping to a match inside one
opens it. Reasoning hidden by the thinking setting is not searched. Enter,
F3 or Cmd/Ctrl+G steps forward, and Shift reverses. The current match scrolls
into view, and every match on screen is painted. ⌥C, ⌥W and ⌥R toggle match
case, whole word and regex. A one-line selection seeds the query, Esc closes
the bar, and the count stops at 10,000.

The bar (`components/search/FindBar.tsx`) is shared with find in an artifact.
Its toggles and the matching (`shared/text-search.ts`) are shared with the
Files pane's search too ([files.md](files.md#search-in-files)), which has its
own panel. Each surface reaches its own text, and has its own limits.

## Tool renderers

| Tool               | Treatment                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`             | Collapsed file chip: path, line range, size; click opens the file in Files pane. Returned images render inline                                                                                                                                                                                                                                                                 |
| `bash`             | Terminal-styled block, streaming output, exit-code badge, duration; truncation notice names `fullOutputPath` (text, not a link)                                                                                                                                                                                                                                                |
| `edit`             | Proper diff from `details.diff`/`details.patch` — green/red gutters, collapsed beyond ~40 lines, header shows path + hunk stats, click opens file at `details.firstChangedLine`; feeds Files Changed panel                                                                                                                                                                     |
| `write`            | "Created/Overwrote <path>" chip + collapsible content preview (highlighted)                                                                                                                                                                                                                                                                                                    |
| `grep`/`find`/`ls` | Compact result lists, match counts, truncation notices; rows click through to files                                                                                                                                                                                                                                                                                            |
| `subagent`         | pi-subagents, in both providers. "Delegated to reviewer" with the child's current tool and tool count while it runs, tools · tokens · time once settled; "Started scout · in background" for a detached run; "Listed agents" / "Checked on" / "Stopped" for management actions. Opens onto the task, one card per child, or the agent catalogue. See [Sub-agents](#sub-agents) |
| `task`             | omp's delegation, on an omp session. "Delegating to scout · 0/2 done" while any subagent runs (after the call itself returned, for a background spawn), "Delegated to scout · 2 agents" once all settled. Opens onto the task and one card per subagent. A `task` whose details are not omp's keeps the generic row. See [omp's `task`](#omps-task)                            |
| unknown/extension  | Generic: tool name, collapsed pretty-JSON args, streaming output area, error state. Must look polished with zero special-casing                                                                                                                                                                                                                                                |

### Blocks from the Claude Code provider

Sessions recorded on `@saccolabs/pi-claude-cli` before 0.9.0 carry three shapes
no pi-native provider produces. From 0.9.0 the CLI runs no tools of its own and
never compacts, so a new session produces none of them, but older transcripts
still open. All are handled in `items/transcriptRows.ts`, so tool-UX work
inherits them; anything that re-derives rows from `AssistantBlock`s must handle
them again.

| Shape                                       | Where it comes from                                                                                                                                                             | Treatment                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[Claude Code · Name {args}]` text block    | Tools Claude Code ran **inside its own process** (WebSearch, WebFetch, ToolSearch, the user's MCP servers, sub-agents). pi cannot execute them, so they are never pi tool calls | Parsed into an `externalTool` activity step: grouped with pi's tools, counted in the summary, never markdown-rendered                                                                                                       |
| `[Claude Code · result #<id> {…}]`          | The outcome of one of those calls, in sessions run with `PI_CLAUDE_CLI_TOOL_RESULTS=1`, which also makes the call marker carry `#<tool_use_id>`                                 | Folded into the row its call produced — **never a row of its own**. Gives that row a live state, an outcome line, a failure state and an expandable output preview                                                          |
| thinking block with a signature and no text | Encrypted thinking (fable-5, opus-5, sonnet-5; haiku-4-5 sends plaintext)                                                                                                       | Skipped on settled items. Provider ≥0.4.4 stops emitting them, but sessions recorded earlier are on disk forever. From 0.10.0 these models send thinking summaries instead, unless `PI_CLAUDE_CLI_THINKING_DISPLAY=omitted` |

The marker strings are a **cross-repo wire contract**, documented on the
emitting side. A result payload is complete JSON and parsed strictly; a payload
that does not parse leaves the row settled with no outcome rather than an
invented one. The call marker's argument preview is complete JSON only on
provider ≥ 0.8.0; below that it is cut at 120 characters, so `externalToolInfo`
reads it **best-effort only** to pick a headline. `Agent`/`Task` markers (sessions
before 0.9.0; live delegation is [Sub-agents](#sub-agents) below) fold
into `subagent` steps, one per agent (three markers describe each), and feed
the composer's sub-agent strip. **A sub-agent row's status claims only what its
markers prove**: `launched` until the CLI confirms a start, no completion until
one is reported. Its live step and running cost come from the
`claude-subagents` status channel, joined by `taskId`
([extensions.md](extensions.md#how-provider-transcripts-render)). Nothing may
ever _depend_ on the preview parsing: a marker with unreadable args still
renders as a plain named step.

## Sub-agents

One engine for both providers: pi owns the tools on a Claude session too, so
delegation always goes through the `pi-subagents` extension inside pi, and
Phosphor renders it from four RPC channels (`features/chat/subagentRuns.ts`,
every reader defensive, a payload it cannot read leaving the generic row).

- **The `subagent` tool call is the row**, in pi's vocabulary: the verb is
  what the model did, the object is the agent, the hint is what it is on
  right now (`read src/auth.ts · 3 tools`, from the progress pi-subagents
  streams on `tool_execution_update`) or what it cost (`44 tools · 80k tokens
· 4m 27s`). A workflow script names its agents (`scout · worker`); a
  management action gets its own verb (`Listed agents`, `Checked on`,
  `Stopped`, `Read the guide on workflows`). The group line counts launches as
  `delegated 2 agents` and management calls as ordinary tools.
- **It opens onto the task and one card per child** (`tools/SubagentDetail.tsx`):
  agent, session name, state, model · tools · turns · tokens · time · cost;
  while it runs, the current tool, the last three tools and the last line it
  said; settled, its answer as markdown and its session file. pi-subagents
  redacts the task in its details, so the card shows the one from the call.
  `action: "list"` renders the agent catalogue with the ones that cannot run
  struck through and the reason beside them.
- **A detached run has no child here.** The tool returns at once; the run's
  tree then rides the `subagent-async` widget (one line of
  `PI_SUBAGENT_ASYNC_JSON:`, pi-subagents' documented host protocol), which the
  status strip's sub-agent chip summarizes (`1 background agent running ·
scout · grep`) and which is **never printed as widget lines**
  (`STRUCTURED_WIDGET_KEYS` in `ExtensionUiHosts.tsx`, alongside the
  `subagent-inspect` reply key the protocol says a host must not render). The
  extension removes the widget when nothing runs, so the chip goes with it.
- **The completion is a card where the model woke up.** pi-subagents delivers
  it as a `subagent-notify` custom message and marks a plain success
  `display: false` so its own TUI does not badge an idle tab; Phosphor keeps
  that one hidden message (`CustomItem.quiet`) because the reply after it
  quotes the result and a reader could not see why the model spoke again.
  `items/SubagentNotice.tsx` reads the header (`Background task completed:
**scout**`) into "scout finished in the background" and folds the output
  under it; a failure, a stop, or a `subagent_control_notice` opens by default.

Not here yet: an expandable fleet tree with stop and steer, opening a child's
own session file as a transcript, and the parent-plus-child cost report.
Stop, steer, inspect and cost exist in pi-subagents without a model turn (an
extension command and an in-process RPC), which is the path for them.

### omp's `task`

omp does not run pi-subagents. It delegates through its own `task` tool, and
its RPC reports the subagents in frames of its own (`omp://rpc.md`, "Subagent
subscriptions"), which `electron/pi/omp-dialect.ts` handles. The rows reuse
the model above (`subagentRuns.ts`, "omp's `task`"): one `task` call, one
card per subagent, the same collapsed row vocabulary and the same chip.

- **Every omp session subscribes at `progress`** when its transport settles,
  ahead of anything queued, on a new session and a resumed one. That level
  forwards `subagent_lifecycle` (started, settled) and the coalesced
  `subagent_progress` frames, whose `AgentProgress` carries all a card shows.
  `events` (every raw event of every subagent) has no reader. pi is never
  sent the command.
- **A card per subagent**, joined on omp's agent id from three sources: the
  call's `TaskToolDetails` (`progress[]` per spawn, `results[]` once a blocking
  call settles), the frames, which the reducer keeps on the call
  (`ToolState.subagents`), and `get_subagents`. A card shows the agent, the
  item name, the current tool with its argument, the last three tools and the
  last line said; settled, the answer (the result's output, or the subagent's
  final `yield`), tools · turns · tokens · time · cost and the model.
- **A background spawn outlives its call.** Under RPC omp runs every agent not
  declared `blocking` as a background job, so the call returns at once and the
  row stays live until the frames settle every card; the status strip's
  sub-agent chip counts the ones still running. omp keeps updating the call
  after its end; the client drops those late updates so the finished call is
  not reopened.
- **Reopening.** When a view opens onto a session (a reload, a re-adopted
  lane), `get_subagents` restores the cards of subagents still running; a live
  frame already seen wins. A session reopened from disk holds only the
  snapshot omp stored when the call returned, so its background cards read
  `detached`, and omp's own `async-result` completion message in the
  transcript reports the outcome.

`scripts/omp-subagents.zsh` checks this without a model turn: a real
`omp --mode rpc --no-session` accepts the subscription and answers
`get_subagents`, recorded omp frames (`electron/pi/__fixtures__/omp-task-replay.json`)
go through the client, store and row model to running and settled cards, and
a recorded pi-subagents call still produces its rows.

## Rich content (first-class citizens)

- GFM (`remark-gfm`): headings, tables (hover → Copy MD / Copy CSV), task
  lists, footnotes, autolinks, blockquotes. GitHub's `[!NOTE]` syntax is not
  special-cased.
- Code: Shiki, language badge, the three hover actions, horizontal scroll
  contained in the block. One highlighter carries both themes, so a theme
  switch re-paints from CSS variables and never re-highlights. Unknown
  languages load on demand and fall back to plain text.
- ` ```mermaid ` → diagram in the Phosphor palette, re-rendered on theme
  change. Click (or focus and press Enter/Space) opens a near-full-window
  viewer, initially fit to its canvas. Zoom buttons and scroll/pinch zoom up
  to 400%; drag pans, Fit recenters, and 100% restores intrinsic size. With
  the canvas focused, +/− zoom, arrow keys pan, F fits, and 0 restores 100%.
  Resizing the window refits the diagram. Copy source copies Mermaid text;
  Save SVG exports the diagram at intrinsic size in the current palette.
  Close, Escape, or the backdrop dismisses the viewer and restores focus.
  The same viewer serves artifact diagrams. A parse error falls back to the
  code block with the error under it.
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
  the popover below. The denominator is pi's context window, or the
  **context budget** where one applies (Settings → Agent → Context budget,
  200k unless set; `sessionContextBudget` in `shared/context-budget.ts`): a
  session whose catalogue capacity is at least the budget gets a capped
  effective window on every provider
  ([cli-providers.md](cli-providers.md#one-context-budget)). pi compacts before
  prompts and between tool cycles, with response headroom below that cap.
  The percentage shows actual overshoot (703k / 400k is 176%); only the ring
  is capped at 100%. The popover names the excess and the next safe check,
  and shows catalogue capacity separately from the effective session window.
  Live window changes come from the context extension between stats polls.
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
costs no round trips. Message and tool-call counters also advance from
`message_end`, including user/system messages before the first usage delta.
Deltas never increment counts; a stats poll resets their baseline. This keeps
long runs from showing more messages in context than in the entire session.

**Context composition** answers "full of _what_": messages, system prompt,
tool schemas, MCP tool schemas. pi's single `contextUsage.tokens` cannot say
that. Only the **total is authoritative**: component sizes are character-based
estimates (no tokenizer is reachable from an extension), labelled approximate,
and free space is the honest remainder. When over budget, the bar normalizes
against used context so segments still add up to 100%; legend percentages
remain fractions of the budget/window and are explicitly labelled as such.

**Messages means what the model holds now.** The extension walks pi's own
`buildContextEntries()` (the last compaction's summary plus the kept tail),
never the whole branch, and estimates each entry the way pi's `estimateTokens`
does: user and tool-result text, images at pi's stand-in, assistant text,
thinking and tool-call arguments, compaction and branch summaries. That list
is the only cut, Claude Code included: the provider replays it whole, so an
old `[Claude Code · compact {…}]` marker counts as text in its message.
`Messages · N` in the legend is that in-context count; `Messages (all)` in the
Session column is pi's count over the whole file. They differ on purpose.

`breakdownSlices` fits estimates to pi's total and never inflates them. The
fixed parts (system prompt, tool schemas, MCP schemas) are measured exactly
and are **never scaled**; an overshoot comes off the message estimate, which
is the one that can be wrong, and the fixed parts shrink only if they alone
exceed pi's total (a stale poll). Scaling all four by one factor is the bug
this replaces: 4.6k of system prompt read as 1.5k and the same seven proxy
schemas read "34" on one session and "77" on another. The extension can only
measure pi's own state. Whatever the provider wraps around it is its own
**Unmeasured** slice, with the drift between the character estimate and the
tokenizer: on Claude Code, the CLI's framing of pi's tools and history. Before
provider 0.9.0 that slice was most of the request, because the CLI also sent
its own system prompt and tool schemas and kept its tool results and
compaction summary in its own transcript. Never fold provider-side context into
a row that names something else, and never let the parts sum past the total.
An absurd total or a dominant Unmeasured slice is evidence about the provider's
`totalTokens`, not about the estimate.

**MCP servers** breaks the MCP slice down per connector, as chips
(`name  loaded/total  ~tokens`), because a single slice cannot say which
server to disconnect. `loaded` is how many of the server's tools have a schema
in the window right now, `total` is how many it offers (from the adapter's
status snapshot; `?` until it reports), and the tokens are the schema cost.
Under the gateway a server is **one proxy tool** (`mcp__<server>`, tens of
tokens each, identical across servers) and reads `0/61`: its tools are fetched
on demand and never carried in context. A server with `directTools`, or a
search-mode activation, is the exception: those schemas land in the window and
the chip reads `12/61` with a cost in the thousands
([mcp.md](mcp.md#the-claude-provider-reaches-mcp-through-pi-not-around-it)).

**Plan usage vs Plan limits** answer different questions and are never merged.
**Plan usage** is the always-on percent per window (5-hour, weekly, per-model
weekly), the same numbers the CLI's `/usage` and Claude Desktop show, fetched
live (no quota, no key) when the popover opens and cached ~60 s in main
(`electron/claude/usage.ts` parses the CLI's rendered text; a parse that yields
nothing hides the section). The poll passes `--no-session-persistence`; without
it every refresh left a transcript under `~/.claude/projects`. **Plan limits** is the binding constraint as the
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
