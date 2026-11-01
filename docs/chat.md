# 04 — Chat: Composer, Streaming, Rich Rendering

The transcript shows the work, not just the answer: text streams, thinking has
its own block, tool calls become steps you can open, an edit shows its diff.
The composer is one small field with several ways in.

## Composer

- New and existing lanes use **`composer/ComposerInput.tsx`**, not separate
  input cards: the same field, attachments, dictation, slash/file menus, Swarm
  control, and toolbar layout. Model and submit controls bind to draft defaults
  or a live session. History, shell execution, Continue, Stop, queues and context
  usage require an existing session.
- Multi-line. Enter sends, Shift+Enter newline. IME confirmation keys never
  send. On a touch-first device without hover (a phone's soft keyboard,
  `lib/softKeyboard.ts`), Return adds a line like Shift+Enter and the send
  button sends; Cmd/Ctrl/Alt+Enter from a connected keyboard still sends.
  There, the shared send button also closes the keyboard so the reply has the
  screen.
- **Two groups and a strip.** The row under the field holds controls only.
  Left, what the agent gets: attach and the [Swarm](#swarm-authorization)
  pill. Right, the engine then go: the model · thinking split chip, then
  **Continue | Send** (Stop while a turn runs) behind a hairline. Each group
  is one unit, so at a narrow width the right group drops to its own line
  whole instead of chips wrapping one by one. Every readout sits in the
  **status strip** under the box: the context ring with `36% of 200k` (opens
  the [usage popover](#what-the-context-meters-popover-shows)),
  `Rules 2/2 · MCP 6/9` (opens the [context sources](#context-files)
  popover) and, for a provider pi does not ship, its name in mono. The strip
  also holds the `/ @ !` cheat sheet while the field is empty, and is the line
  a draft starting with `!` takes over to explain itself. The home composer
  has the same shape, with only the rules and connectors in its strip. It is
  one component for This Mac and every Host (`features/home/StartComposer.tsx`,
  [remote creation](remote-desktop.md#machine-context-and-lane-creation)); a
  target offers only what it has before a lane exists.
- **Continue:** a compact play icon immediately left of Send, behind a
  hairline so the two never read as one slot, sends the literal message
  `continue`, without sending or clearing the draft or attachments. It is the
  recovery control (after a restart, a transient error or an unfinished turn):
  disabled while resuming, awaiting a reply, streaming or compacting, and
  available again in a reopened session after an app restart. It uses normal
  prompt delivery; if pi's process crashed, use **Resume session** first.
- **Markdown list primitives.** Shift+Enter continues the list the caret is on
  (renumbering; an empty item steps out a level, then exits). Tab/Shift+Tab
  nest and un-nest inside a list (Tab takes an autocomplete suggestion first
  when one shows). Cmd/Ctrl+Shift+8 and +7 toggle bullet and
  numbered, Cmd/Ctrl+B and +I wrap, Cmd/Ctrl+Shift+C fences. **Enter sends
  from a hardware keyboard**; continuation is deliberately not on it, or a
  one-line prompt starting with `- ` would stop sending. A phone's Return
  already means "another line", so it continues the list. Logic in `libs/client-ui/src/lib/composerText.ts`; keymap in
  `composer/ComposerField.tsx`, shared by both composers.
- **Formatting is keyboard-only**: bold, italic, inline code (Cmd/Ctrl+E), code
  block, lists and links (Cmd/Ctrl+Shift+K). No toolbar. Edits go through
  Chromium's `insertText`, so native Undo/Redo works.
- **Spelling.** Chromium underlines misspelled words in every text field.
  Right-clicking one opens the app's menu with up to five suggestions, _Add to
  dictionary_, then Cut / Copy / Paste / Select all; picking a suggestion goes
  through `insertText`, so Undo works. Electron has no menu of its own, so
  before this a right-click in a text field did nothing. Details and the
  switch: [settings.md](settings.md#writing).
- **Autocomplete** (off by default, Settings → Writing): ghost text after the
  caret, learned from the prompts you send. Tab or → at the end takes it all,
  ⌥→ (Ctrl+→ off macOS) one word. Esc only hides it, like closing a popup, so
  hiding a suggestion never stops a run or arms the rewind. It stays hidden
  while the `/` or `@` popup is open, during ↑/↓ recall, in `!` shell mode,
  during IME composition and whenever the caret is not at the end. The field
  grows with your text, not the suggestion, so a suggestion longer than the
  field shows is cut to the whole words that fit (`lib/writing/fitGhost.ts`);
  Tab inserts exactly what shows, never words below the edge. Local and
  instant; no model is called.
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
- A queued message is a chip above the composer, not a bubble. Its bubble
  appears in the transcript only when pi delivers it (the user `message_end`),
  so it sits after the work the agent finished first. Each chip has a ✕ that
  undoes just that entry. pi has no per-entry command, so `composer/queueActions.ts` drains with
  `clear_queue` (pi 0.84.4+; refused on older pi) and re-queues the survivors.
  On a Host lane the controller does the same through the Host, and `!cmd`
  runs in the Host's shell.
- A `!cmd` shows as a bash item (`composer/runShellCommand.ts`). While it runs,
  whoever may command the lane sees **Stop**, which sends `abort_bash` (pi's
  abort does not stop a shell). A Host lane's command that outlasts the Host's
  deadline shows as unconfirmed, not failed, and keeps Stop
  ([remote desktop](remote-desktop.md)).
- `@` → fuzzy file search across the workspace (gitignore-aware), inserts a
  path reference.
- **Dictation:** with voice input on (Settings → Voice), a microphone beside
  Attach records until clicked again, then inserts the transcript at the caret
  without sending. Undo removes it. Transcribed locally ([voice.md](voice.md)).
- Images: paste or drag → thumbnails → sent as `images[]` with the prompt.
  Both composers accept attachment-only messages, including the first message.
  If pi resizes or converts them, its appended image-processing hints confirm
  the pending local message rather than adding a second bubble. The original
  text and image previews stay on that row; pi's timestamp identifies it for
  rewind. Only the known hint suffix and the same image count qualify, not
  arbitrary appended prose or an already confirmed message.
- Remote controllers can attach files when the ready Host announces
  `workspaces.write` and `sessions.control`. Images travel inline as on local
  lanes, but each is first fitted into 2000 px, the square pi resizes every image
  to before a model sees it (`lib/shrinkImage.ts`). A phone photo drops from
  several MB to a few hundred KB, so it fits the prompt frame on a weak link. A
  GIF, an image that already fits, or one the browser cannot re-encode smaller is
  sent as it is; local lanes always send the original. Main refuses encoded image
  prompt frames above the Host inbound limit
  minus a 1 KiB margin without sending or clearing the image draft; documents upload through main before the prompt, at most 20 MiB each
  and ten attachments per message. The Host path appears only in the normal
  `<attached-files>` block. Failure or uncertainty sends no prompt and never
  retries chunks. Remote document bytes stay in memory, bounded to 64 MiB across
  drafts, and disappear on restart, removal, lane close or abandoned upload;
  attach the file again after an upload failure. Neither these bytes nor local
  or Host document paths are persisted in remote drafts.
- **Clicking a pending image opens the annotator** (`features/chat/imageEditor/`),
  not the lightbox. Box, circle, arrow, pen, highlighter, text and numbered
  markers, with colour, size, undo/redo and select-to-move/resize. ⌘V (or
  _Paste image_) puts another image on top; ⇧⌘V (or _Replace image_) swaps the
  screenshot underneath, keeping the marks. _Done_ flattens everything into one
  PNG, which is all pi receives: the annotations are pixels, never prompt text.
  _Replace original_ (on by default) swaps the chip in place; off, the copy is
  attached right after the original and the user removes either. The layers
  ride along in memory (`PendingImage.annotation`) so reopening keeps them
  editable; a draft restored after a restart comes back flattened. Images
  already in the transcript are not editable: copy one and paste it.
- **Drafts persist.** Text, attachments and the model the draft was composed
  against live in `libs/client-ui/src/stores/drafts.ts`, keyed per session or per home
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
  - **Search** (`commandScore` in `libs/client-ui/src/lib/fuzzy.ts`) ranks exact name, then
    name prefix, then a whole segment (`/debug` → `skill:debug`), then a
    segment prefix (`/deb` → `skill:debug`), then a subsequence, then a
    substring of the description (`/status` → "Show MCP server status"). `:` is a word
    boundary. Nothing typed: grouped Phosphor / Extensions / Prompts / Skills
    with section headers, pi's registration order within a group.
  - **Every row says where it comes from** (`commandCatalogue.ts`): pi's
    `sourceInfo` becomes a short origin — the package name (`pi-web-access`),
    `built into pi` for pi's inline extensions, `project · .claude/skills` for a
    local skill — and the tooltip carries the whole description, the file
    path and any aliases.
  - **Aliases fold.** Two commands from the same file with the same description
    are one row (an extension registering one handler under two names); the
    alias stays searchable and is named in the tooltip. Matching is on payload
    equality, never on a hardcoded name.
  - **Host controls are demoted**: `/phosphor-context-files`,
    `/phosphor-reload` and `/phosphor-swarm` are not in the browse list, are
    still found when typed, and are described with a pointer to the control
    that sends them.
  - **The list stays fresh.** Main broadcasts `pi:commandsChanged` after a
    package install/remove/update, the MCP migration, a skill mutation or a pi
    sign-in; the renderer drops the home composer's per-folder cache and
    re-issues `get_commands` on every live session. The chat composer also
    re-asks its own session on `/`, throttled to once per 30 s, which catches
    commands an extension registers mid-session. A live pi does not load a newly
    installed extension until it restarts, so for packages only the home
    composer changes.
  - **The menu never silently vanishes.** With nothing to list it shows why:
    loading (the home probe spawns a pi), pi unreachable (with the reason from
    `pi:commands`' `error`), or no match — in which case Enter is not consumed
    and sends the text to pi as a prompt, as the row says.
  - Not possible today: argument completion (`/mcp ⇥` → `reconnect`, …). An
    extension can define `getArgumentCompletions`, but pi's RPC exposes no
    command for it.
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
  - **While it streams**, the run's last row shimmers "Thinking 8s · <newest
    sentence>", falling back to the latest section title while a Codex section
    (its summaries open each section with `**Title**`) has only its title. The
    group's line keeps its step summary, with "thought for Ns" ticking.
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
- **A row's size is known in the commit that mounts it**, not a ResizeObserver
  frame later (`items/measureRow.ts`). The follow effect only ever bottoms out
  on geometry the same commit produced, so a wheel in the frame after a turn
  settles is never undone by a late `scrollTop = scrollHeight`.
- **A following view keeps the tail in sight when the viewport resizes.** The
  composer grows as a draft wraps, and gains its steer row on the first key of
  a running turn; the virtualizer does not re-render for that, so the
  scroller's own ResizeObserver bottoms out a pinned view. An unpinned one is
  left where it is.
- **Typing renders the field, not the strips around it.** The composer's
  status strips, model picker and readouts subscribe to the chat store
  themselves and are memoised on the session, so a keystroke never re-renders
  them (`Composer.renders.test.tsx`). The transcript never subscribes to the
  draft at all.

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
  back to the composer. `bootstrapSession` re-runs to learn the new file path,
  and the abandoned file is recorded as rewound, so the sidebar folds it away
  and, if it is opened anyway, a banner links to where the chat continues
  ([lanes.md](lanes.md#forks-and-saved-history)).
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
Its toggles and the matching (`libs/shared/src/text-search.ts`) are shared with the
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
  right now (`read apps/desktop/src/auth.ts · 3 tools`, from the progress pi-subagents
  streams on `tool_execution_update`) or what it cost (`44 tools · 80k tokens
· 4m 27s`). A workflow script names its agents (`scout · worker`); a
  management action gets its own verb (`Listed agents`, `Checked on`,
  `Stopped`, `Read the guide on workflows`). The group line counts agents,
  not calls: one `parallel` call with four tasks is `delegated 4 agents`
  (`launchedAgentCount`). Management calls count as ordinary tools.
- **It opens onto the task and one card per child** (`tools/SubagentDetail.tsx`):
  agent, session name, state, model · tools · turns · tokens · time · cost;
  while it runs, the current tool, the last three tools and the last line it
  said; settled, its answer as markdown and its session file. pi-subagents
  redacts the task in its details, so the card shows the one from the call.
  `action: "list"` renders the agent catalogue with the ones that cannot run
  struck through and the reason beside them.
- **A detached run has no child here.** Its launch row is a historical
  receipt, not a live status. The tool returns at once; the run's tree then
  rides the `subagent-async` widget (one line of
  `PI_SUBAGENT_ASYNC_JSON:`, pi-subagents' documented host protocol), which the
  status strip's sub-agent chip summarizes (`1 background run active ·
scout · grep`) and which is **never printed as widget lines**
  (`STRUCTURED_WIDGET_KEYS` in `ExtensionUiHosts.tsx`, alongside the
  `subagent-inspect` reply key the protocol says a host must not render). The
  extension removes the widget when nothing runs. A session with the command
  installed or a recorded delegation keeps a quiet Subagents chip for inspection.
  **Above the composer, a persistent current-work summary** combines foreground
  delegation tool evidence with background snapshots, even while Artifacts
  occupies the pane. It starts compact: one line with a pulsing dot while agents
  run, the headline (`2 agents working · 1 needs parent attention · parent idle`,
  plus unavailable counts and incomplete-snapshot warnings) and, while collapsed,
  a muted ticker with the title of the agent that reported most recently and what
  it is doing (`Write remote.md · bash 12s · 4 tools`). Only the agent counts are
  a `role="status"` live region: the parent's working/idle state and the ticker,
  which changes with every tool call, are not announced. On a narrow composer the
  ticker gives way first, then the headline truncates; **View subagents** stays.
  Expanding lists one row per agent (up to eight current, then a
  `+N more in the Subagents pane` line, then the three most recent under
  **Recent**, which includes paused and stopped work); collapsing reclaims
  composer space. **View subagents** opens the
  full pane without expanding the summary. Updates never change the disclosure
  state; switching lanes or remounting starts compact.
  **One agent, one row.** pi-subagents projects a single-agent run as a root
  plus its one `step:0` child; Phosphor shows that as one row routed to the step,
  whose session holds the activity, and an **Inspect run** link naming the run
  selects the same row, also after a restart when only the launch remains and
  the saved target is the step. Workflow and parallel children are rows of their
  own, grouped under their run; a workflow coordinating between children is its
  group's header, not an extra row. Workflow ancestors and children are not counted twice;
  native run IDs deduplicate foreground/background handoffs. Historical launch
  receipts and management calls never count as running. A top-bar badge mirrors
  the active count and flags attention or unavailable status.
  **A row says what the agent was asked and what it is doing.** Line one is a
  title from the delegated prompt and elapsed time (running) or a state word.
  Delegated prompts often share a long preamble, so the title is the first of a
  prompt's sentences that the fewest other prompts in the lane contain, with
  paths shortened to file names. Identical prompts (retries) count once, and the
  whole lane is compared at once, so a title does not change when its agent
  finishes. A call naming several tasks is titled by their count. Titles are
  display only: identity always comes from native run IDs, and a row's
  accessible name starts with its title. Line two is the agent (when the title
  is a prompt), its model, `in <run>` outside its group, its current tool and how long it
  has been open, else `working`, or `quiet 40s` after 15 seconds without a
  report, then the reported tool count and `#<run>`. A long tool name truncates;
  its duration and the counts do not, and the run ID gives way first. The model
  is the one pi-subagents reports the child running on (foreground details, or a
  snapshot step's `model` and `thinking`, which pi-subagents publishes only once
  nicobailon/pi-subagents#2893 ships), else the one the launch asked for (a
  step's own `model`, then the call's), with the provider dropped
  (`gpt-6.1-sol:medium`); the tooltip, the panel header and the background launch
  note keep the full ID. A background launch that names no model, on a
  pi-subagents without that field, shows none. Each
  step's prompt binds by its native index
  for parallel and plain chains; a chain with nested parallel groups binds none,
  and a workflow prompt is never a child's task. Both lines are fixed height, so
  updates never move rows. Elapsed and quiet times tick from one clock per
  surface (`useNow`), which runs only while something is active and updates only
  while the window is visible; it never polls. Data arrives from the pushed snapshot, which pi-subagents
  republishes on each tool call, turn or activity change.
  Request timestamps come from the parent's recorded tool-call message, falling
  back to an observed launch-call start for detached work. They never become child
  execution starts or restore liveness. Known execution/request times drive
  ordering; undated entries follow in record order, newest recorded first.
  Rows open the exact background run/child or the foreground delegation's
  existing detail component in the shared pane. Finished work is not review
  acceptance or integration success. Messages still go to the parent; the
  summary does not extend the parent's timer, change Send into Stop, or redirect
  the composer to a child.
  Missing, malformed or later-omitted snapshots retain bounded, memory-only
  evidence (up to 40 roots) as **status unavailable**, not live work or completion.
  With nothing working, the headline then counts agents, not "No agents working".
  One transcript fact stands in for a missing report: an unanswered
  `subagent_supervisor_request` for that exact run ID, received during the
  current parent run (no `subagent_supervisor` reply naming its request ID), shows **waiting for reply** on `contact_supervisor`,
  counted as working and needing parent attention, as pi-subagents itself
  reports a blocked child. A live snapshot always wins over it. pi-subagents
  withdraws its snapshot when an automatic compaction starts and republishes it
  only when a parent turn starts or settles, so after a mid-turn compaction no
  background status arrives for the rest of that turn
  ([known-issues.md](known-issues.md) M7); the summary says so while it applies.
  The last report time and incomplete snapshots are qualified. Exact
  native terminal notices can settle missing status; names and artifact paths
  cannot. Closing the session clears this cache, and restarting never restores
  old liveness. Foreground activity requires an execution start observed within
  the current parent turn; a replayed/orphaned tool cannot revive on a later turn.
  No additional polling, heartbeat deadline or runner is added.
  **View subagents**, the footer chip and notice links open the shared Subagents
  pane, also available in the top bar and command palette. It supports docking,
  resizing and fullscreen like Files and Terminal. Its navigator stays anchored
  while the selected detail scrolls; a long list scrolls independently.
  **Agents** lists live, remembered and foreground work with the same row as
  the summary: **Working** (running or status unavailable) first, then
  **Earlier**, each newest first. Children of one workflow or parallel run stay
  together, in the run's own order, under a header naming the run, which selects
  the run itself; the group moves into Working whole if any child is current. Foreground history shows the newest 20 plus
  active and selected delegations. Below 640px pane width, list and detail are
  separate views with **Back to runs** and focus restoration.
  Selecting a node asks
  the installed `/subagents-inspect-rpc` command for a bounded, read-only task,
  transcript window and result. Replies are correlated to the exact session,
  request and child, including emit-then-retract replies. No child session is
  opened for writing. Missing commands, expired artifacts and foreign-session
  targets show explicit errors; no model fallback or file scraping is used.
  The selected active node refreshes every five seconds while its detail view and
  window are visible/focused, with one request in flight. Opening coordination,
  returning to the narrow list or covering the pane with a global page pauses it.
  Failures back off and pause after three attempts; Refresh retries explicitly. Selection changes and
  closing cancel outstanding reads. A settled node gets a final read, not an
  endless poll.
  The last view and exact target are remembered against Pi's durable session ID,
  not a process ID. Reopening checks current-branch history or a current native
  snapshot before restoring selection. A clone does not inherit preferences.
  The pane layout may restore like other panes, but never restores an old running
  state. Docking and fullscreen preserve the mounted inspector, including drafts
  and disclosures; closing it cancels reads.
  **The detail answers three questions in order: what is it doing, what did it
  return, what was it asked.** It renders from the snapshot at once, before the
  first read lands. The header carries the title, a state dot and
  `state · agent · elapsed · tools · turns · #run`, with a Refresh icon. The
  state comes first so a narrow pane never truncates it; the agent appears only
  when the title is a prompt; elapsed is the running time or a reported
  duration, never time since a start for work with no reported end. A running
  agent opens on **Now**: its current activity line and its last six records,
  newest first. **Result** follows (always once the agent has settled; while it
  runs, only once there is output), tagged by origin: **Received by
  parent** only for the parent's own settled tool result; otherwise **From the
  agent's record**, which is not proof of delivery. Child metadata alone never
  earns the parent tag. A single-run or explicitly correlated child completion
  notification is a separate **Parent was notified** disclosure: it may only
  reference a saved file, so it never replaces the inspected answer. A containing
  workflow or multi-run batch receipt is never assigned to an individual child.
  Missing output stays missing. Whole JSON values are pretty-printed; no result is
  inferred from the last assistant/tool message. **Task** shows the delegated
  prompt as Markdown, clipped with **Show full task** past 360 characters or six
  lines, with Copy. Authored Markdown follows the pane's type scale, so a
  prompt's own headings never outrank the agent's title; later
  messages to the agent have their own disclosure. **All activity** is one closed
  disclosure of single-line records (tool calls, outputs, errors, thinking,
  messages), each expandable with Copy. Records are classified from the
  inspection reply's reported `kind`, `name` and `isError`, else the
  `[tool: name]` marker; the preview never invents per-message times,
  call/result pairing or tool outcomes. Foreground parallel prompts bind to their
  native child index in the foreground detail. Child file/artifact references stay
  non-interactive because inspection does not report a verified child workspace
  or artifact namespace; web links still work. Refreshes keep the reader's scroll
  position. IDs, run-level status qualifications, steering, Stop and snapshot
  actions live in **Details & actions**. Only the header's state word announces
  updates, not the activity.
- **The completion is a card where the model woke up.** pi-subagents delivers
  it as a `subagent-notify` custom message and marks a plain success
  `display: false` so its own TUI does not badge an idle tab; Phosphor keeps
  native coordination messages (`CustomItem.quiet`) because the reply after
  them quotes evidence that would otherwise be invisible. This includes hidden
  `subagent-incremental-child-notify` records: a completed workflow child stays
  visible even while its siblings run. Explicit child/workflow IDs remain distinct;
  completion does not mean acceptance, and sibling status is labelled as of that
  update. `items/SubagentNotice.tsx` reads the header (`Background task
completed: **scout**`) into "scout finished in the background". **Every notice
  starts folded to that one line** with its time, whatever its status; a
  failure or an attention notice keeps its warning tone while folded. The
  output, the signal, the run, workflow and request IDs and the original
  diagnostics are all behind the disclosure. Run identity comes only from
  native data: a `subagent-notify` completion's `details.runs[].runId`, a
  workflow child's `Child run:` line, or an attention event's `runId`; never
  the prose or an artifact path. A notice naming exactly one run shows
  **Inspect run** on the folded line, including in the Coordination log, so
  the run opens in the Subagents pane without expanding the card. A grouped
  completion lists an **Inspect** link per run inside the disclosure. This
  uses the same ownership-checked extension command, never a writable child
  session. Structured attention notices name the workflow key and profile in
  the headline and keep the signal with the diagnostics.
  A long-running tool warning is parent-facing, not proof of a stall or a human
  blocker. Historical signals remain historical; Phosphor does not mark them
  resolved merely because a later notice arrives.

- **Questions name the parent, not the user.** Native
  `subagent_supervisor_request` messages render as "asked the parent for
  guidance", with their run, child index, request ID and timestamp. Custom
  messages retain their original structured `details` in both live and resumed
  transcripts. Historical requests never claim to be currently pending.
- **Completion requires evidence.** A settled tool without a child exit code or
  reported state shows "last known", not success. Current `workflow: true`,
  path and resource calls coexist with older `workflowScript` transcripts.

The Subagents panel's **Coordination log** view reads Pi's `get_entries`
only on opening or Refresh. It follows `leafId` and `parentId`, excludes
abandoned branches, and includes pre-compaction questions and plain
`subagent_supervisor_reply` entries. It shows at most 200 records and reports
omissions. Plain state remains outside model context; Phosphor writes no
journal and never appends to a live session file. Older extensions can lack
reply records. The view also derives launch/resume receipts from the branch's
native tool calls/results, including before compaction, with a separate
200-launch bound. Detached launch receipts never imply current activity.
Questions pair with parent replies by exact request/run identity, not agent
names. Live pairing requires a successful native reply result; arguments alone
are not delivery evidence. A paired card adds "parent replied" to its folded
line, and the reply opens with the question. The original question notice
remains available. A recorded reply does not prove the child acted on it.
The view describes evidence at read time, not current liveness.

**Stop run** is available on a root inspection when the session advertises the
extension's Stop command. It asks for confirmation, rechecks that the exact
root is still active in this session, and calls `/subagents-stop <full-id>`.
A notice-linked child inspection is not offered Stop unless that exact run is
also a root in the current snapshot.
Pi checks ownership again. The UI reports only that Stop was requested; native
`subagent-slash-result` receipts, including hidden final receipts, remain in
the conversation and the Coordination log. Placeholder/final command receipts
with the same native request ID fold into one presentation, live and on replay;
Pi's original entries remain untouched. No optimistic stopped state or
process-exit proof is invented. Stop does not remove partial file changes.

**Steer…** addresses the exact selected active root or child through the
advertised extension command, rechecking capability and current-session activity
at send time. The extension checks ownership and records the delivery result.
The UI never claims the instruction was applied, never falls back to a model
prompt, and never redirects the ordinary composer. Steering does not answer a
supervisor question. The extension flattens message whitespace.

**Save snapshot** explicitly retains the displayed inspection window in
Artifacts. It includes native session/run/child identities, read time, reported
state and truncation, with all captured text preserved literally. It is not a
full transcript or live state. The bundled artifact extension owns the save:
`/phosphor-save-subagent-snapshot` appends a non-context entry through Pi and
returns a correlated receipt. Existing sessions without the command need a Pi
restart. Saving alone neither switches panes nor closes inspection. The saved
artifact survives compaction and native child-artifact expiry; failed later
reads leave any last successful preview labelled as such. Reopening an expired
unsaved inspection cannot recover its output. There is no automatic archive of
all child transcripts and no renderer-maintained execution journal.

Not here yet: human supervisor reply buttons, profile discovery/editing, the
parent-plus-child cost report and descendant-aware lane deletion. There is no
automatic continuation or new global delegation directive.

### Swarm authorization

The lane composer's **Swarm** switch grants standing authorization for proactive
delegation and orchestration when useful. It does not launch children, eagerly
activate subagent tools, duplicate the extension's skill, or widen task permissions.
Off keeps the existing normal delegation rules, including delegation explicitly
requested by the user or authorized by project instructions.

**Before a lane exists**, the same switch records an explicit choice on that
workspace's unsent draft, including across restarts. Its hint explains that
pi-subagents availability is checked on startup. The choice is consumed on send,
not inherited by the next new lane or another workspace. Startup verifies the
host command is registered and awaits its successful application **before the
first prompt**, in both plain folders and worktrees. If unavailable or rejected,
no task runs: the draft and choice return with an error, and the unused process
is disposed. A missing command is never sent as an ordinary model prompt.

In an **existing lane**, the switch is a pill with four looks, all driven by Pi's
acknowledged status (`composer/SwarmSwitch.tsx`, `swarm.css`), never an optimistic
renderer preference. Its glyph is the Beacon with three signals on the orbit, and the
geometry carries the state, so no look depends on colour or motion alone:

- **Unavailable** (no status yet, or pi-subagents not loaded): dimmed, heads
  pulled in, no hover reaction.
- **Off**: quiet pill, heads pulled in; hover eases them outward as a preview.
- **Pending** (a toggle Pi holds until the turn ends): dashed amber pill, an
  `on next turn` / `off next turn` tag, a pulsing dot, the composer outline
  dashed, and a toast ("Swarm turns on after this turn."). Clicking again
  cancels the request and toasts "Swarm request cancelled." This is the state
  that used to be an 11px suffix beside an unmoved knob, which read as a click
  that did not take.
- **On**: amber-soft fill, accent hairline and glyph, heads on the orbit; the
  solid amber composer outline and the title badge. The fan-out animation
  plays once, when Pi reports the switch going on: never on hover, and not
  when a lane that is already on is reopened.

While the command is in flight the heads orbit the nucleus. The switch's
[action hint](ui-shell.md#action-tooltips) names the click (Enable Swarm,
Disable Swarm, Cancel the pending change) with the state's sentence as its
description, which is also the switch's accessible description; reduced motion
disables every animation. Enabled styling means
authorization, not running work. Activity and inspection still use the existing
Subagents surfaces, including for normal lanes.

`/phosphor-swarm on|off` is a host command in the bundled context extension. It
persists a non-context custom entry through Pi, scoped to the durable session ID and
current branch, and publishes `phosphor-swarm` status. Resume/reload restores it;
compaction retains it; tree navigation follows the selected branch. Forks and clones
with new session identities start off. This includes Rewind (also Esc-Esc), which
uses Pi's fork even though it stays in the same visible lane. Cloning a live lane
also moves it onto the new identity with Swarm off. Old lanes must reload/restart Pi
to acquire the command. A missing or excluded pi-subagents tool surface disables activation.

The short `phosphor_swarm` authorization section is added **request-locally** by
`context_with_system`, including native background-completion requests. Switching
off removes that section from subsequent requests entirely, rather than appending a
contradictory “off” instruction. A mid-run change stays visibly pending until
`agent_end`, so it never changes policy beneath an in-flight turn. Changes made
while Pi is still busy after that boundary (compaction or continuation preparation)
apply at settlement, or at the next `agent_start` if Pi continues without settling.
Pre-run compaction changes likewise apply before the first request. Existing children
are not stopped; use their explicit Stop controls. Past messages/results, summaries
that describe past work, and already-activated tool schemas remain. The current
context instruction is reversible, not the lane's history or token spend. Switching
can invalidate provider prompt caches, including Claude's warm CLI cache.

The context meter includes the short block's estimated size while applied. Pi's
reported total still reflects its last measured request until the next model call.
No new manager, scheduler or hard spawn budget is introduced.

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
  `apps/desktop/electron/artifacts/artifact-protocol.ts`).
- KaTeX for `$…$` / `$$…$$`.
- Images inline with click-to-zoom.
- **Links split by what they point at** (`components/markdown/MarkdownLink.tsx`).
  An `http(s)` URL opens in the default browser. A path (`docs/chat.md`,
  `./README.md`, `/abs/path`, `file://`) opens in the **Files pane** at the
  line it names (`#L42` or `:42`); an unreadable path toasts. A file link
  renders with no `href`, so no click can navigate the window away. Other
  schemes do nothing.

## Agent directives

Phosphor appends its directive blocks in this order: worktree guard, machine
awareness, lane charter, sub-agent policy. Each is a switch with no free text;
what the user writes for every lane is the machine's
[global instructions](#global-instructions). pi's own system prompt and project
rules remain separate inputs. The blocks are composed once
for a process spawn; a resume that starts a new process uses current context and
preferences. Reopening an already-live process does not replace its prompt.

Settings > Agent > Directives has **Machine awareness**, default on, backed by
its own `AgentDirectivePrefs.machineAwareness` field. Like other directives it can
be set globally or per project on This Mac. When enabled, a signed-in local lane
gets one sentence inside `<phosphor_machine>`:

> You are running on the user's own computer, where Phosphor's window is.

Signed-out local lanes get no machine block. Native and Claude sessions receive
the same text. [Host machine awareness](host.md#machine-awareness) owns the Host
identity, repository summary and service-safety instructions, including routine
runs. These are prompt instructions, not network authorization.

The spawn log records `--append-system-prompt` but replaces its value with
`[redacted]`; the composed prompt is not dumped into argv logs.

### Global instructions

The user's own instructions for every lane live in pi's global instructions
file, not in Phosphor: the first of `AGENTS.override.md`, `AGENTS.md` and
`CLAUDE.md` that pi finds in its agent directory (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`). Terminal pi and routines read the same file. Each machine
has its own; nothing copies or syncs it between This Mac and a Host.

**Settings → Agent → Directives → Edit instructions** opens This Mac's file; a
Host's opens from its Agent defaults ([settings.md](settings.md#host-machine-settings)).
The editor is a full-window markdown editor with Edit and Preview tabs, **Save**
and Cmd/Ctrl+S (`features/settings/instructions/`). Its header names the machine
and the file, marked "created on save" when pi finds none; then it creates
`AGENTS.md`. A save carries the revision it read, so a file changed elsewhere is
refused with **Reload**, never overwritten. The file is capped at 256 KB because
every request carries it. Closing over unsaved edits asks first; the backdrop
never closes it. Phosphor never writes a repository's AGENTS.md or CLAUDE.md.

A saved file reaches running lanes from their next model request, with no
restart: the bundled context extension re-reads it in `context_with_system` and
swaps it into pi's `project_context` section
([extensions.md](extensions.md#bundled-extensions-phosphors-own)). A turn already
streaming finishes with what it was sent. Lanes started before the extension
had the swap pick the file up after one restart.

The Settings field "Your own text" was retired into this file. On the first
start with this version, This Mac's global text is appended once to its global
instructions file. A project's text, and global text the file refused, is kept in
`AppPrefs.retiredDirectives`; Settings lists it with a copy button until
**Dismiss**.

## Context files

Both composers carry a **Rules · MCP** readout in the status strip under the
box (`composer/ContextSourcesMenu.tsx`); its popover holds two checkboxes,
**CLAUDE.md** and **AGENTS.md**, and the MCP connectors ([mcp.md](mcp.md)). Unchecked, the model is
not sent the files of that name that pi found for the lane, which can be
thousands of tokens on every request.

- **Home composer:** sets what new lanes start with (`AppPrefs.contextFiles`,
  default both on). Main hands it to pi at spawn.
- **In a lane:** changes that lane from its next model request, mid-turn
  included, with no restart, and also the starting state of new lanes, so the
  last choice sticks. Other running lanes keep their own state. A lane's boxes
  show what its pi reports, not the preference. Under **Instruction files**,
  each checkbox lists the discovered paths, their approximate costs, and
  whether they are included or excluded. **Global** means pi's user agent
  directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`); **Project** means the
  working directory or an ancestor directory, including inherited rules
  outside the repository. Scope comes from the extension, not the filename.
  Older extensions show **Scope unknown** rather than guessing. Before a lane
  reports its files (and on Home), the pane says file details are unavailable;
  a dimmed label with `none` means discovery found no matching file.
  A checkbox controls its filename category in the project scope, not an
  individual file. The global file always stays: it is what the user wrote for
  every lane ([Global instructions](#global-instructions)). The readout's count is enabled categories, not files.
- **Routines** always send every context file, whatever the preference: an
  unattended run keeps the project's rules ([routines.md](routines.md)). A
  routine-owned lane refuses a toggle, like any other manual command, until
  the routine lets it go. The Host CLI has no such preference and sends every
  file.

The filter runs inside pi ([extensions.md](extensions.md#bundled-extensions-phosphors-own))
and leaves the transcript untouched. Each in-lane toggle also appends a
`phosphor-context-files` custom entry (`{ off: [...] }`, never sent to the
model); the newest one on the branch wins over the spawn-time value at
`session_start`, so a lane keeps its choice across an extension reload and
when it is reopened later. Shared rules live in
`libs/shared/src/context-files.ts`; the IPC is `app:setContextFile`
(`apps/desktop/electron/pi/context-files.ts`); spawn-time state is set in
`libs/session-runtime/src/pi/session-policy.ts`.

## Session controls (per session)

The model · thinking chip lives on the right of the **composer footer**
(`Composer.tsx`; attach and Swarm are on the left), the context meter and the
[Rules · MCP readout](#context-files) in the status strip under it; the
session's ⋮ menu is in the **top bar** (`app/TopBar.tsx` → `SessionMenu`).

- **Model picker** (from `get_available_models`), grouped by **family** by
  default so every route to one model sits under one header, toggleable to
  provider grouping, with `provider:`/`id:`/`name:`/`is:` search qualifiers,
  starred and recent rows. Custom and local providers are listed too. A model
  that cannot run is listed dimmed and unselectable with its reason; on a Host
  that is the same rule its new-lane picker applies
  ([remote creation](remote-desktop.md#machine-context-and-lane-creation)).
- **Thinking-level selector**: pi has **seven** levels, `off` → `max`. Which
  ones a model offers is per model: a non-reasoning model has only `off`,
  `xhigh`/`max` are opt-in. A live session asks pi
  (`get_available_thinking_levels`); the home picker derives the same answer
  from `libs/shared/src/thinking.ts`. The segment is hidden unless the model has
  more than one level.
- **Two owners, one chip.** `ModelPicker` drives a live session over RPC
  (`set_model`). `HomeModelPicker` has no process to talk to, so it reads and
  writes pi's own `defaultProvider` / `defaultModel` / `defaultThinkingLevel`.
  Both render `composer/ModelChip.tsx`: the model name as the left segment,
  the thinking level (with a caret) as the right. The provider is not on the
  chip: it is in the chip's tooltip and, in a session, in the strip, named only
  when pi does not ship it (`namedProvider`).
- **Context meter**: % of window from `get_session_stats` (polled after each
  `agent_end` and on demand), shown in the strip as `36% of 200k` with the
  ring, warn state near the compaction threshold, and the popover below. The denominator is pi's context window, or the
  **context budget** where one applies (Settings → Agent → Context budget,
  200k unless set; `sessionContextBudget` in `libs/shared/src/context-budget.ts`): a
  session whose catalogue capacity is at least the budget gets a capped
  effective window on every provider
  ([cli-providers.md](cli-providers.md#one-context-budget)). pi compacts before
  prompts and between tool cycles, with response headroom below that cap.
  The percentage shows actual overshoot (703k / 400k is 176%); only the ring
  is capped at 100%. The popover names the excess and the next safe check,
  and shows catalogue capacity separately from the effective session window.
  Live window changes come from the context extension between stats polls.
- **Stop** (`abort`) is the send button while a turn runs. Everything else is
  in **Session options** (the ⋮ button): Export HTML…, Compact now… (optional
  custom instructions), Auto-compaction, Auto-retry, and the two queue modes
  (Steering, Follow-ups). Each toggle or mode shows its current value as the
  row's hint ("on", "one at a time"); choosing it sends the other value and
  closes the menu. One builder (`features/chat/sessionMenuItems.ts`) makes the
  list for every surface: Desktop's top bar, the end of the wide browser's
  lane tabs, and the phone lane sheet's Session group. It opens with
  `showMenuBelow`, so it is a popover on wide screens and the action sheet on
  phones. On a Host lane the commands go through `piCall` to the lane's pi and
  need control: a reader sees them disabled with "Take control first." (the
  shared lane actions' rule), and a Host that is not connected or does not
  offer control says so instead. Export HTML (and `/export`) does not need lane
  control. On a Host lane the Host exports and returns the document
  (`hosts:exportLaneHtml`); Desktop then saves it where the save dialog says,
  asked before the Host is, and a browser downloads it as a file it never
  renders. A stopped lane says to resume it first. Renaming is `/name` or the sidebar row.

### Streaming text is paced, not rendered per delta

Delta granularity is a provider property. The Claude Code provider batches
prose into ~90-character chunks half a second apart, where pi-native providers
send token-sized deltas tens of milliseconds apart. Rendering each chunk on
arrival lands Claude turns in slabs.

So the visible text is a paced slice of the store's exact text: `useSmoothedText`
(leaf-local, per prose block) drains the backlog at a rate proportional to its
size, aiming to empty it in about one upstream gap. `libs/client-ui/src/lib/textReveal.ts`
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

Six sources, three confidence levels, and the UI keeps them distinguishable
because they are not equally trustworthy.

| Section                 | Source                                                         | Shown for                         |
| ----------------------- | -------------------------------------------------------------- | --------------------------------- |
| Tokens / cost           | `get_session_stats`                                            | every session                     |
| Context composition     | `phosphor-context-breakdown` status key (bundled extension)    | every session                     |
| Optimization · Headroom | `phosphor-headroom` status key (bundled extension)             | sessions that compressed a result |
| Plan usage              | `claude:usageSnapshot` IPC — `claude -p /usage`, live percents | Claude Code provider sessions     |
| Plan usage (remote)     | `hosts:claudeUsage` IPC → Host `machine.claudeUsage`           | Claude Code lanes on a Host       |
| Plan limits             | `claude-rate-limit` status key (provider ≥0.4.5)               | Claude Code provider sessions     |
| ChatGPT plan usage      | `pi:codexUsage` IPC → ChatGPT `/backend-api/wham/usage`        | `openai-codex` sessions           |

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

**Not every provider reports usage while it streams.** `libs/client-ui/src/lib/liveStats.ts`
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
that. Only the **total is authoritative**: component sizes are estimates (no
tokenizer is reachable from an extension, and Messages/Thinking are measured
from usage only where the request history allows), labelled approximate,
and free space is the honest remainder. When over budget, the bar normalizes
against used context so segments still add up to 100%; legend percentages
remain fractions of the budget/window and are explicitly labelled as such.

**Messages means what the model holds now.** The extension walks pi's own
`buildContextEntries()` (the last compaction's summary plus the kept tail),
never the whole branch. That list is the only cut, Claude Code included: the
provider replays it whole, so an old `[Claude Code · compact {…}]` marker
counts as text in its message.

**Messages and Thinking are measured from pi's usage where they can be**
(`pi-ext/message-ledger.ts`). Two consecutive requests differ by exactly what
was added between them, so `input(k+1) - input(k)` is reply k plus the tool
results and messages after it, in real tokens. When that difference holds all
of `output(k)`, the reply was kept whole: its visible text and tool calls go to
Messages, the rest of its output to **Thinking**, and the remainder of the
difference is the exact size of the entries in between. Thinking is its own row
because a Claude model streams only a summary of its reasoning while the full
reasoning stays in the window; counting the summary missed 73k tokens on one
Opus session. The chain holds only since the provider last rebuilt the
request (a compaction, a model switch, or input falling by more than 20%,
which is pi-claude-cli replaying history without thinking). Before that point,
and for any pair whose figures do not add up, entries are estimated pi's way
(user and tool-result text, images at pi's stand-in, assistant text, thinking
summary and tool-call arguments), divided by the session's own median
chars-per-token from the measured pairs (about 2.4 on code-heavy work, against
pi's 4). A session with no usage yet uses 4.
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
**Unmeasured** slice, with what remains of the estimate's error (the fixed
parts and history from before the last rebuild): on Claude Code, the CLI's framing of pi's tools and history. Before
provider 0.9.0 that slice was most of the request, because the CLI also sent
its own system prompt and tool schemas and kept its tool results and
compaction summary in its own transcript. Never fold provider-side context into
a row that names something else, and never let the parts sum past the total.
An absurd total or a dominant Unmeasured slice is evidence about the provider's
`totalTokens`, not about the estimate.

**MCP servers** breaks the MCP slice down per connector, as chips
(`name  loaded/total  ~tokens`), because a single slice cannot say which
server to change. `loaded` is how many of the server's tools have a schema
in the window right now, `total` is how many tools pi registered for it once
it connected (`?` from a session whose extension did not say), and the tokens
are the schema cost. Under pi's default `codemode` exposure a server reads
`0/61`: up, and its tools reached through pi's `codemode` and `tool_search`,
never carried in context. A `direct` server, or tools `tool_search` has
loaded, are the exception: those schemas land in the window and the chip
reads `12/61` with a cost in the thousands
([mcp.md](mcp.md#exposure-how-tools-reach-the-model)).

**ChatGPT plan usage** uses the same dials for the account signed into pi's
`openai-codex` provider. Main asks `pi auth check --provider openai-codex
--json --credentials` (pi owns OAuth refresh), then sends the bearer token and
its `chatgpt_account_id` claim to the fixed HTTPS endpoint used by
[OpenAI's Codex client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs).
No model call, Codex CLI, browser cookies or new login is needed. Credentials
stay in main memory, never IPC, logs or Phosphor storage. Redirects are refused.

Window labels come from `limit_window_seconds`, not primary/secondary order:
some plans expose only a weekly primary. Dials show **percent used**, not the
website's percent left, with reset countdowns. When supplied, workspace
`spend_control.individual_limit` credit allowance renders remaining/total and
its reset. Other credit balances, reset-credit redemption and model-specific
additional limits are not displayed. These are account totals, not this
session's consumption. Main shares concurrent reads and caches successful
HTTP results for 60 seconds, keyed by the current credential's fingerprint;
auth is resolved on each read so another login cannot inherit the cache.
Refresh bypasses it. Missing/unsupported data, auth failures, rate limiting and
network errors stay visible as a reason, never a fabricated zero. This is an
internal upstream endpoint, so schema drift can make usage unavailable.

**Claude Plan usage vs Plan limits** answer different questions and are never merged.
**Plan usage** is the always-on percent per window (5-hour, weekly, per-model
weekly), the same numbers the CLI's `/usage` and Claude Desktop show, fetched
live (no quota, no key) when the popover opens and cached ~60 s in main
(`apps/desktop/electron/claude/usage.ts` parses the CLI's rendered text; a parse that yields
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
The CLI's reset stamp is parsed in both forms it has printed (`Aug 30 at 2:49pm`,
and `Oct 19, 6:29am` from Claude Code 2.1.283); an unparsed stamp drops only
the countdown.

It reads the lane's OWN account (`claude:sessionAccount` →
`claude:usageSnapshot <id>`) and names it once more than one Claude login is
configured. Asking without an id read whichever credential the CLI keeps by
default, which on a multi-account install is routinely a different plan than
the lane is spending. **Switch account** lists every other signed-in login and
moves this lane to the one picked, held accounts included and marked. The move
is a respawn, not a switch: a running lane's credential was fixed at spawn, so
the lane is disposed and resumed from its session file against the new
account, and the next turn re-reads the whole thread.

**A remote lane reads the Host's plan, not this computer's.** It spends an
account on the Host, so its section is titled `Plan usage · Claude on <machine>`
and comes from that Host's own `claude -p /usage` for the account the lane bills
(`hosts:claudeUsage` → [`machine.claudeUsage`](host.md#claude-machine-diagnostics)).
Its **Switch account** moves the lane to another account on that Host, as This
Mac's does ([cli-providers](cli-providers.md)). It needs lane control, and asks
for the Host's settings access first if this client lacks it; the picker stays
open through the reconnect that grant causes, then reads the Host's accounts. A
failed read says so and offers Retry, and usage is re-read after every move
attempt, confirmed or not. A Host older
than the call says so in the section and offers Refresh, rather than hiding it.

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

## Lane notices

A background lane's completion appears as a Receipt card with a machine-coloured
edge and chip, title, repository/branch, and an answer excerpt or “Stopped: …”.
Known facts show duration, files and lines ±, test pass/fail and artifacts; missing
facts stay absent. File counts cover the run's completed successful `edit`/`write`
tools, not git status or a count of every filesystem change. Test facts come from
recognized standalone test commands, not arbitrary prose or compound shell commands.
Legacy Claude tool markers use the shared `libs/shared/src/external-tool-marker.ts`
recognition rather than becoming answer excerpts.

Open lane opens the destination. View changes appears when files are reported and
opens its Changes pane. Retry appears for errors and opens/focuses that lane's
composer; it does not resend a prompt. Dismiss closes the notice. For a This Mac
lane, or a Host lane already opened in this window, the existing card updates rather
than stacking a new one. A Host lane never opened here can stack one card per event.

This Mac lanes notify in-app only. Host attention can include facts from the
[read-only receipt call](remote-protocol.md#lane-receipt-call); an older Host's
refusal keeps the plain card without invented facts. Host OS notification bodies
show facts or fixed status, never the answer excerpt. Main's freshness and timeout
rules are in [receipt enrichment](remote-desktop.md#attention-receipt-enrichment).

### Notice navigation

In-app cards, Host attention toasts, OS clicks and pending This Mac rows use
`navigateToLane`. It aligns this window's machine filter while keeping All
machines, closes any global page, and opens or adopts the lane. Later user
navigation cancels the pending operation. An offline Host or removed lane leaves
the current view in place with one error toast. An OS click affects one window,
not every window. A saved This Mac row clicked under a Host filter switches the
filter to This Mac and opens its session directly, without `navigateToLane`.

Success reveals the destination's sidebar group: expand, never toggle closed,
and clear that group's search. This Mac groups use the sidebar's own project and
representative-folder grouping rule, so worktree rows reveal the correct group.

## Remote lanes

Remote lanes use the same transcript renderer as local lanes. The header names
the machine; the control strip names the controller. Viewers have a read-only
composer and an explicit Take control action. There is no automatic takeover.
Controllers can prompt, steer, queue, abort, compact, change model and thinking,
answer dialogs, stop and resume. The machine's capabilities and current control
are checked in main and again by the Host. A prompt to a stopped lane resumes it
once and then delivers the message: a Host restart stops every lane, and sending
is the intent to run it. Steer, follow-up and the rest stay refused.

Remote creation uses the target machine's configured repositories and model
catalogue. An unavailable Host never starts a local session instead.

Create from the Host home composer; [remote creation](remote-desktop.md#machine-context-and-lane-creation)
owns repository, thinking and branch choices.

Slash commands come from the lane; file mentions search its Host file list.
Thinking levels derive from its model. Continue waits for the receipt and echo
rather than inserting an optimistic duplicate. The Files, Changes, Terminal and
Artifacts panes route to the Host when their capabilities are announced. Remote
Subagents do not inspect local sessions. Missing capabilities show the fixed
unavailable hint, not local machine data. The full [gap list](future-features.md#remote-surface-gaps)
owns unsupported actions.

Remote transcripts remain in memory. Drafts use Host-qualified lane keys; local
attachment paths and uploaded Host document paths are not persisted in remote
drafts. A reconnect reset replaces history through the normal hydration path.
The composer disables during disconnection and recovers from the Host snapshot.
While the Host connects or reconnects it stays on screen with its draft, locked
(dimmed, `aria-busy`) under a spinner note that names the machine, and the lane
header holds its control buttons; a lane held elsewhere is the only read-only one.
Opening or focusing the lane marks it read on the Host; counters clear across
clients. [Desktop routing](remote-desktop.md) owns connection and receipt details.

[Lane notices](#lane-notices) share one machine-aware navigation path.

Remote Artifacts requires `artifacts.read`; see [remote artifacts](remote-desktop.md#remote-artifacts).
