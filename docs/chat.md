# 04 — Chat: Composer, Streaming, Rich Rendering

## Composer

- Multi-line input; Enter sends, Shift+Enter newline. IME candidate-confirmation keys never send, accept a suggestion or abort a run. Selected text uses the browser's normal Shift+Enter replacement, rather than list continuation.
- Formatting/list transformations participate in Electron's native Undo/Redo. The shared textarea records minimal plain-text edits through Chromium's `insertText` editing API; it never inserts HTML. Unsupported browser harnesses retain controlled-value editing, without a native-undo guarantee.
- **Markdown list primitives** ([2026-08-28-composer-list-primitives.md](log/2026-08-28-composer-list-primitives.md)). Shift+Enter continues the list the caret is on (renumbering as it goes; an empty item steps out a level, then exits), Tab/Shift+Tab nest and un-nest inside a list only, Cmd/Ctrl+Shift+8 and +7 toggle bullet/numbered, Cmd/Ctrl+B and +I wrap, Cmd/Ctrl+Shift+C fences. **Enter always sends** — continuation is deliberately not on it, or a one-line prompt starting with `- ` would stop sending. Logic is pure in `src/lib/composerText.ts`; the keymap lives in `composer/ComposerField.tsx`, which both composers share.
- **Formatting controls** are available in Home and live chat: bold, italic, inline code (Cmd/Ctrl+E), code block, bullet/numbered lists and links (Cmd/Ctrl+Shift+K). Inserting a link selects its URL placeholder. Controls, key handling and Settings → Keybindings share `composer/formattingActions.ts`; the command palette uses plain Cmd/Ctrl+K, not the link chord.
- **Long prompts:** Expand input / Cmd/Ctrl+Shift+X opens up to half the window height, without replacing the textarea or losing its selection/draft. Collapse restores the 240px autogrow cap. This remains a Markdown textarea, not a WYSIWYG editor.
- Sent user messages render their list runs as real lists (`UserText`), not as literal `- ` text. Deliberately not a full markdown renderer: the bubble also carries the `<attached-files>` block.
- **While streaming**: Enter queues a **steering** message (delivered after the current turn's tool calls), Alt/Cmd/Ctrl+Enter queues a **follow-up** (after the agent finishes). Match pi TUI semantics exactly; the two queues are visually distinct. Escape aborts and restores queued messages to the composer.
- While running, **Steer now** and **Queue follow-up** expose both send modes without a keyboard. They stay in place (disabled while the draft is empty), retain input focus after use, and keep Stop available.
- `queue_update` renders queued chips above the composer (steer = one color, follow-up = another). A chip exists only while pi has not read that message, so each carries a ✕ that undoes just that entry. pi has no per-entry command, so `composer/queueActions.ts` drains both queues with `clear_queue` (**pi 0.84.4+**, above `MIN_PI_VERSION` — on an older pi the drain is refused and the queue is left intact) and re-queues the survivors in order. The index a chip was rendered at is only trusted when the text at it still matches, because pi can deliver a queued message between render and click.
- `@` → fuzzy file search across the workspace (gitignore-aware), inserts a path reference chip/text.
- Images: paste or drag → thumbnails in composer → sent as `images[]` (base64) with the prompt.
- **Drafts persist** ([2026-08-28-persisted-composer-drafts.md](log/2026-08-28-persisted-composer-drafts.md)). Text, pending attachments and the model a draft was composed against live in `src/stores/drafts.ts`, keyed `session:<sessionFilePath>` or `home:<workspacePath>`, and survive switching session (the composer subtree unmounts) and quitting. Image bytes go to `userData/drafts/` by blob id, never into prefs.
- The model chip and the model menu have an explicit **loading** state; an empty list before the catalogue answers is never rendered as "no models configured" ([2026-08-28-model-catalogue-loading.md](log/2026-08-28-model-catalogue-loading.md)).
- `!command` → RPC `bash` (output shown in chat, enters model context on next prompt). `!!command` → same with `excludeFromContext: true` and a "not sent to model" badge. Surface both in a composer hint.
- `/` → command menu fed by `get_commands` (extension commands, prompt templates, `skill:*` — with source badges and descriptions) merged with pidex-native commands (new, fork, clone, compact, export, model, name, tree…). Sending an unknown `/x` still goes to pi as a prompt (pi expands templates/skills itself).
- Composer widget slots above/below for extension `setWidget`; `set_editor_text` prefills the input.

## Streaming rendering rules

- Reduce `message_update.assistantMessageEvent` deltas incrementally into per-message view-models; never rebuild the whole list per delta.
- **Text deltas** render as live markdown. Fenced blocks render their rich form only once the fence closes (skeleton/plain-mono while open) to avoid flicker.
- **Thinking deltas** stream into a collapsed-by-default "Thinking…" block with subdued styling; respect pi's `hideThinkingBlock` setting; expandable during and after streaming.
- **Tool calls** appear as cards at `toolcall_start`, args fill from deltas, then live output attaches via `tool_execution_update` (partialResult is accumulated — replace displayed output each update), final state at `tool_execution_end` (success/error styling).
- Virtualized message list; long sessions (1000+ entries) stay smooth. Autoscroll with "jump to bottom" pill when the user scrolls up.
- **Following the tail is one-way from geometry.** A scroll sample can stop the follow, never start it: a transcript that shrinks (an activity group collapsing when its run settles) clamps `scrollTop` to the tail, and that clamp is indistinguishable from a reader who chose the bottom. Following resumes only on a gesture — wheel/keys toward the tail, a scrollbar drag back to it, the pill, or sending a message.
- **A reader who scrolled away keeps their place through any layout change.** While unpinned the content box is floored at the reader's own viewport bottom, so a shrink reserves empty space below the last row instead of dragging them down. The floor only lowers (further read-back) and is dropped on re-pin. A viewport-relative CSS minimum also protects the reader when composer controls disappear and the scrollport grows.

## Message affordances

- Copy message / copy as markdown; code blocks: copy, "open as file", "run in terminal", "open as artifact".
- User messages: **fork from here** (`fork` entryId) and edit-and-refork.
- Error/abort stopReasons styled clearly (error banner with message; aborted = muted "stopped" divider).
- Auto-retry: inline strip "Retrying (2/3) in 4s — <error>" with cancel (`abort_retry`).
- Compaction: `compaction_start/end` render a system divider "Context compacted — N tokens summarized" (expandable summary). Branch summaries similar.

## Tool renderers

| Tool               | Treatment                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`             | Collapsed file chip: path, line range, size; click opens the file in Files pane. Returned images render inline                                                                                                                                                    |
| `bash`             | Terminal-styled block, streaming output, exit-code badge, duration; truncation notice links `fullOutputPath`                                                                                                                                                      |
| `edit`             | Proper diff from `details.diff`/`details.patch` — green/red gutters, collapsed beyond ~40 lines, header shows path + hunk stats, click opens file at `details.firstChangedLine`; feeds Files Changed panel ([05-files-editor.md](specs/build/05-files-editor.md)) |
| `write`            | "Created/Overwrote <path>" chip + collapsible content preview (highlighted)                                                                                                                                                                                       |
| `grep`/`find`/`ls` | Compact result lists, match counts, truncation notices; rows click through to files                                                                                                                                                                               |
| unknown/extension  | Generic: tool name, collapsed pretty-JSON args, streaming output area, error state. Must look polished with zero special-casing                                                                                                                                   |

### Blocks from the Claude Code provider

Sessions on `@saccolabs/pi-claude-cli` carry two shapes no pi-native provider
produces. Both are handled in `items/transcriptRows.ts`, so tool-UX work
inherits them for free — but anything that re-derives rows from
`AssistantBlock`s must handle them again.

| Shape                                       | Where it comes from                                                                                                                                                             | Treatment                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[Claude Code · Name {args}]` text block    | Tools Claude Code ran **inside its own process** (WebSearch, WebFetch, ToolSearch, the user's MCP servers, sub-agents). pi cannot execute them, so they are never pi tool calls | Parsed into an `externalTool` activity step: grouped with pi's tools, counted in the summary, never markdown-rendered. There is **no result** — only what was invoked |
| thinking block with a signature and no text | Encrypted thinking. Measured: fable-5, opus-5, sonnet-5 all do this; haiku-4-5 is the only family sending plaintext                                                             | Skipped on settled items. Provider ≥0.4.4 stops emitting them, but sessions recorded earlier are on disk forever                                                      |

The marker string is a **cross-repo wire contract**; the emitting side
documents its shape. The argument preview is truncation-prone and therefore
frequently invalid JSON; `externalToolInfo` reads it **best-effort only**
(JSON.parse, then a complete-`"key":"value"`-pairs fallback) to pick a human
headline — `Agent`/`Task` markers instead fold into `subagent` steps, one per
AGENT rather than one per marker (three markers describe each), and feed the
composer's sub-agent strip (`trailingUnfinishedAgents`). **A sub-agent row
claims only what its markers prove**: `launched` until the CLI confirms a
start, and no completion until one is reported. Background agents ran to their
death before provider 0.4.14
([log/2026-08-22-claude-subagents-never-return.md](log/2026-08-22-claude-subagents-never-return.md),
[log/2026-08-28-subagents-report-back.md](log/2026-08-28-subagents-report-back.md));
pidex pins no version, so both shapes are rendered from evidence and neither
is assumed.
Nothing may ever _depend_ on the preview parsing: a marker whose args are
unreadable still renders as a plain named step.

## Rich content (first-class citizens)

- GFM: headings, tables (copy as markdown/CSV), task lists, blockquote callouts, footnotes, autolinks.
- Code: Shiki/hljs, language badge, copy, line numbers on hover, horizontal scroll contained inside the block.
- ```mermaid → rendered diagram; click for pan/zoom lightbox; export PNG/SVG; parse errors fall back to code with an error note.

  ```
- `vega-lite / `chart → theme-aware rendered chart; invalid spec falls back to code.
- ```html → Code/Preview toggle; preview in sandboxed iframe (`sandbox` attr, no network, inlined content only).
- KaTeX for `$…$` / `$$…$$`.
- Images in content blocks inline with click-to-zoom.

## Session header / status strip (per session)

- Model picker (from `get_available_models`, grouped by provider — remember custom/local providers exist), thinking-level selector (off→xhigh, hidden if model lacks reasoning).
- Context meter: % of window from `get_session_stats` (poll after each `agent_end` + on demand); warn state near compaction threshold. Token/cost readout (input/output/cache split in a popover), plus the two sections below.
- Controls: Stop (`abort`), Compact now (`compact`, optional custom instructions input), auto-compaction toggle, auto-retry toggle, steering/follow-up mode toggles ("all" vs "one-at-a-time"), rename session, export HTML (save dialog → `export_html` → reveal/open).

### Streaming text is paced, not rendered per delta

Delta granularity is a provider property, and the Claude Code provider's is
coarse: measured 2026-08-27, prose arrives in ~93-character chunks ~550ms
apart (the CLI batches the API's SSE stream), where pi-native providers send
token-sized deltas tens of milliseconds apart. Rendering each chunk on
arrival made Claude-provider turns land in harsh slabs.

So the visible text is a paced slice of the store's exact text:
`useSmoothedText` (leaf-local state, per prose block) drains the backlog at a
rate proportional to its size, aiming to empty it in about one upstream gap —
`src/lib/textReveal.ts` holds the pure pacing math, unit-tested against the
recorded cadence. Rules that matter:

- **The store is never touched.** Pacing lives in the one streaming block's
  component; `buildTranscriptRows` does not re-run per tick, and commits are
  capped at ~30Hz because each one re-parses that block's markdown.
- **Mount shows everything already present.** Hydrated history and
  virtualizer re-mounts must never replay a typewriter.
- **Settling drains fast instead of snapping**, so a turn doesn't end with
  one final pop of text.
- **rAF has a timeout backstop.** Hidden windows (background tabs, the e2e
  suite's never-shown windows) starve rAF; throttled timers still tick, so
  the text always completes even where nobody is watching.
- `prefers-reduced-motion` disables the reveal entirely.

### What the context meter's popover shows

Four sources, three different confidence levels — and the UI is required to
keep them distinguishable, because they are not equally trustworthy.

| Section             | Source                                                         | Shown for                     |
| ------------------- | -------------------------------------------------------------- | ----------------------------- |
| Tokens / cost       | `get_session_stats`                                            | every session                 |
| Context composition | `pidex-context-breakdown` status key (bundled extension)       | every session                 |
| Plan usage          | `claude:usageSnapshot` IPC — `claude -p /usage`, live percents | Claude Code provider sessions |
| Plan limits         | `claude-rate-limit` status key (provider ≥0.4.5)               | Claude Code provider sessions |

**Plan usage vs Plan limits.** The two plan sections answer different
questions and must never be merged into one dashboard. **Plan usage** is
the always-on percent per window (5-hour, weekly, per-model weekly) — the
same numbers the CLI's own `/usage` panel and Claude Desktop show, fetched
live (zero quota, no key) when the popover opens and cached ~60 s in main
(`electron/claude/usage.ts` parses the CLI's rendered text; a drift that
parses nothing hides the section). **Plan limits** is the binding
constraint as the provider relays it mid-turn — one window, only once the
CLI's warning threshold has crossed it, but the only source that can say
"capped now" between turns. All-day percent: Plan usage; the wall: Plan
limits.

**The meter is the only door to all four, so it must not close.** It renders
whenever the session has stats, and draws the ring unfilled with a `—` when
the percentage is briefly unknown. It used to return `null` on a null
percent, which is exactly the state pi reports from the moment a session
compacts until fresh usage arrives — the ring vanished, and with it the
popover and the `claude:usageSnapshot` fetch that only ever runs when the
popover opens. "Usage never showed up" was usually this, not a failed fetch.
For the same reason Plan usage now always renders a row: `Checking…` while
the run is in flight, then the windows or the one-line reason there are none
(`usageUnavailableReason`, shared with Settings → Claude Code). A section
that disappears on failure is indistinguishable from a fetch that never
happened, and the fetch never happening was the actual bug.

**Context composition** answers "full of _what_" — messages, system prompt,
tool schemas, MCP tool schemas — which pi's single `contextUsage.tokens`
number cannot. Only that **total is authoritative**: component sizes are
character-based estimates (no tokenizer is reachable from an extension), so
`breakdownSlices` scales them onto pi's real total, free space is the honest
remainder, and the popover labels them approximate. Never present an
estimate as measured, and never let the parts sum past the total.

That scaling makes the total load-bearing twice over, and it is worth knowing
how it failed. Until `pi-claude-cli` 0.4.10, a Claude session's
`contextUsage.tokens` was the episode's **summed billing**, not its context:
pi derives context from `usage.totalTokens`, and the provider set that to
input + output + cacheRead + cacheWrite across every cycle of the turn, so
the cached prefix was counted once per API round trip. A 4-call turn read
277k against a real 78k; a 26-call turn read 2.08M against a real 104k. The
composition rows inherited the error exactly, because they are scaled onto
that total — which is how a lane came to report a 146k system prompt. Both
numbers are only as good as the provider's `totalTokens`, and a component
row that looks absurd is evidence about the total, not about the estimate.

**Plan limits** is account state, not session state: the window
(`five_hour`), when it resets, whether the account is capped or on overage,
and — from provider 0.4.9 — how much of that window is consumed. Older
providers send the window and its reset without a percentage, so the bar is
omitted rather than guessed; `utilization: null` and "none used" must never
look the same. It renders only when the key is present, so other providers
show nothing rather than an empty section.

This is the only figure on the popover that comes from the account rather
than from a token count, which makes it the one to trust when they disagree:
sub-agent spend reached it (server-side) long before provider 0.4.10 taught
the token rows about sub-agents at all.

Crossing the CLI's own warning threshold (≥75% utilized, or a hard cap) also
opens a dismissible banner above the composer (`composer/RateLimitBanner.tsx`),
gated by `needsAttention` — the same threshold the popover's own warn/danger
coloring uses, so the two surfaces can't disagree about what counts as urgent.
It goes quiet again once a fresh event reports a healthy percentage or
`resetsAt` has passed; an always-on banner for a number that's fine most of
the time is the alarm-fatigue mistake `LaneBanner` was rewritten to avoid
repeating. A dismiss is keyed to the exact reading shown, so a later event
that's worse reopens it rather than staying hidden.

Both keys arrive through pi's extension-UI status channel and land in
`stores/extensionUi.ts` keyed by session; parsing lives in
`composer/contextBreakdown.ts` and `composer/rateLimit.ts`, each of which
returns `null` for a missing or malformed payload so a bad push degrades to
"section absent" rather than a broken meter.
