# 04 — Chat: Composer, Streaming, Rich Rendering

## Composer

- Multi-line input; Enter sends, Shift+Enter newline. IME candidate-confirmation keys never send, accept a suggestion or abort a run. Selected text uses the browser's normal Shift+Enter replacement, rather than list continuation.
- Formatting/list transformations participate in Electron's native Undo/Redo. The shared textarea records minimal plain-text edits through Chromium's `insertText` editing API; it never inserts HTML. Unsupported browser harnesses retain controlled-value editing, without a native-undo guarantee.
- **Markdown list primitives.** Shift+Enter continues the list the caret is on (renumbering as it goes; an empty item steps out a level, then exits), Tab/Shift+Tab nest and un-nest inside a list only, Cmd/Ctrl+Shift+8 and +7 toggle bullet/numbered, Cmd/Ctrl+B and +I wrap, Cmd/Ctrl+Shift+C fences. **Enter always sends** — continuation is deliberately not on it, or a one-line prompt starting with `- ` would stop sending. Logic is pure in `src/lib/composerText.ts`; the keymap lives in `composer/ComposerField.tsx`, which both composers share.
- **Formatting is keyboard-only**, in Home and live chat: bold, italic, inline code (Cmd/Ctrl+E), code block, bullet/numbered lists and links (Cmd/Ctrl+Shift+K). Inserting a link selects its URL placeholder. There is no toolbar strip — the composer is the field and its footer, nothing else. Key handling and Settings → Keybindings share `composer/formattingActions.ts`; the command palette uses plain Cmd/Ctrl+K, not the link chord.
- **Long prompts:** Cmd/Ctrl+Shift+X opens the field up to half the window height, without replacing the textarea or losing its selection/draft. Collapse restores the 240px autogrow cap. This remains a Markdown textarea, not a WYSIWYG editor.
- Sent user messages render their list runs as real lists (`UserText`), not as literal `- ` text. Deliberately not a full markdown renderer: the bubble also carries the `<attached-files>` block.
- **While streaming**: Enter queues a **steering** message (delivered after the current turn's tool calls), Alt/Cmd/Ctrl+Enter queues a **follow-up** (after the agent finishes). Match pi TUI semantics exactly; the two queues are visually distinct. Escape aborts and restores queued messages to the composer.
- While running **and only once the draft has something in it**, **Steer now** and **Queue follow-up** expose both send modes without a keyboard. They retain input focus after use and keep Stop available; an empty draft shows no extra row.
- `queue_update` renders queued chips above the composer (steer = one color, follow-up = another). A chip exists only while pi has not read that message, so each carries a ✕ that undoes just that entry. pi has no per-entry command, so `composer/queueActions.ts` drains both queues with `clear_queue` (**pi 0.84.4+**, above `MIN_PI_VERSION` — on an older pi the drain is refused and the queue is left intact) and re-queues the survivors in order. The index a chip was rendered at is only trusted when the text at it still matches, because pi can deliver a queued message between render and click.
- `@` → fuzzy file search across the workspace (gitignore-aware), inserts a path reference chip/text.
- Images: paste or drag → thumbnails in composer → sent as `images[]` (base64) with the prompt.
- **Drafts persist.** Text, pending attachments and the model a draft was composed against live in `src/stores/drafts.ts`, keyed `session:<sessionFilePath>` or `home:<workspacePath>`, and survive switching session (the composer subtree unmounts) and quitting. Image bytes go to `userData/drafts/` by blob id, never into prefs.
- The model chip and the model menu have an explicit **loading** state; an empty list before the catalogue answers is never rendered as "no models configured".
- `!command` → RPC `bash` (output shown in chat, enters model context on next prompt). `!!command` → same with `excludeFromContext: true` and a "not sent to model" badge. Surface both in a composer hint.
- `/` → command menu fed by `get_commands` (extension commands, prompt templates, `skill:*` — with source badges and descriptions) merged with the Phosphor-native ones, of which there are exactly **three**: `/compact`, `/export`, `/name` (`nativeCommands` in `features/chat/Composer.tsx`). Everything else in that menu is pi's, so the list grows by installing an extension, not by editing Phosphor. Sending an unknown `/x` still goes to pi as a prompt (pi expands templates/skills itself).
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

- Copy message: the raw markdown of the WHOLE turn, even from the pill on one prose block — that is what a reader means by "copy the answer" when a turn interleaves text with tool calls.
- Code blocks carry exactly three hover actions (`components/markdown/CodeBlock.tsx`): **Open as artifact** (promotes the fence into a local artifact, typed from its language — html/svg/mermaid/chart/markdown, else `code`), **Run in terminal** — offered only for shell languages (`bash`, `sh`, `shell`, `zsh`, `console`, `terminal`, `fish`) and pasting without executing — and copy. (`CodeBlock` also takes an `actions` slot rendered ahead of them; no caller fills it today.)
- User messages: **Rewind to here**, plus a branch button opening the multi-message rewind picker (Esc Esc). Both run pi's own `fork` RPC (`features/chat/rewind.ts`), and what that does is worth stating plainly: it branches the live session onto a **new session file** rooted just before that entry, and hands the original text back for the composer to edit and resend. The subprocess and the RPC connection carry on untouched, but `bootstrapSession` must re-run to relearn the new `sessionFile` — skip it and `live[sessionId].diskPath` still points at the abandoned pre-fork file, which reads in the sidebar as the chat having been duplicated. Attachments are restored from the transcript, not from pi: `fork` replies with text only, so the rendered message is the sole surviving copy of an image the user attached.
- Error/abort stopReasons styled clearly (error banner with message; aborted = muted "stopped" divider).
- Auto-retry: inline strip "Retrying (2/3) in 4s — <error>" with cancel (`abort_retry`).
- Compaction: `compaction_start/end` render a system divider "Context compacted — N tokens summarized" (expandable summary). Branch summaries similar.

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
composer's sub-agent strip (`trailingUnfinishedAgents`). **A sub-agent row's
status claims only what its markers prove**: `launched` until the CLI confirms
a start, and no completion until one is reported. Its live step and running
cost come from elsewhere — the `claude-subagents` status channel, joined per
row by `taskId`, because the two markers bracket the agent's whole life and
say nothing in between
([extensions.md](extensions.md#how-provider-transcripts-render)).
Background agents ran to their death before provider 0.4.14, which stopped
`SIGKILL`ing the CLI at each turn's `result` envelope; Phosphor pins no
version, so both shapes are rendered from evidence and neither is assumed.
Nothing may ever _depend_ on the preview parsing: a marker whose args are
unreadable still renders as a plain named step.

## Rich content (first-class citizens)

- GFM (`remark-gfm`): headings, tables (hover → Copy MD / Copy CSV), task lists, footnotes, autolinks, styled blockquotes — plain ones; GitHub's `[!NOTE]` callout syntax is not special-cased.
- Code: Shiki, language badge, the three hover actions above, horizontal scroll contained inside the block. One highlighter singleton carries BOTH themes (`vitesse-light`/`vitesse-dark`) with `defaultColor: false`, so switching theme re-paints from CSS variables and never re-highlights; a language outside the core set is `loadLanguage`d on demand and falls back to plain text if Shiki has none (`components/markdown/highlighter.ts`).
- ` ```mermaid ` → diagram rendered against the Phosphor palette (`theme: 'base'` + explicit `themeVariables`, `securityLevel: 'strict'`), re-rendered on theme change. Click opens a **lightbox** — a scrollable, full-width copy of the same SVG, dismissed by click or Escape. There is no pan/zoom control and no PNG/SVG export. A parse error falls back to the code block with the mermaid error printed under it.
- ` ```chart ` (a Chart.js config: `{ type, data, options? }`) and ` ```vega-lite ` → theme-aware rendered chart; invalid JSON or a spec the engine rejects falls back to the code block with the error.
- ` ```html ` → Code/Preview toggle. The preview is `<iframe sandbox="allow-scripts" src=…>` — **`src`, never `srcDoc`**, and that is load-bearing: a `srcdoc` document inherits the embedder's policy container, so `script-src 'self'` from `src/index.html` refuses every inline script and the sandbox attribute becomes a no-op (measured on Electron 43: interactive artifacts rendered as a page of empty boxes, with Chromium logging the refusal; `blob:`/`data:` inherit the same way). So the HTML is staged in main and **served** over `phosphor-artifact://` under its own `default-src 'none'` policy, which permits inline script/style and `data:`/`blob:` media but no `connect-src`, no remote images, no `form-action`. `allow-same-origin` is deliberately absent, which is what keeps the document's origin opaque and its `localStorage`/parent DOM a `SecurityError`. Net: the artifact gains scripting and loses all network reach. `components/SandboxedHtml.tsx`; the measured containment table lives in `electron/artifacts/artifact-protocol.ts`.
- KaTeX for `$…$` / `$$…$$`.
- Images in content blocks inline with click-to-zoom.
- **Links split by what they point at** (`components/markdown/MarkdownLink.tsx`,
  classified by `lib/markdownLink.ts`). An `http(s)` URL opens in the default
  browser via `app:openExternal`. A path — `docs/chat.md`, `./README.md`,
  `/abs/path`, `file://` — opens in the **Files pane**, at the line it names
  (`#L42` or `:42`); a path that cannot be read toasts and leaves the pane
  alone. A file link renders with no `href` at all, so no click can navigate
  the window away from the app. Other schemes (`mailto:`, custom) do nothing.

## Session controls (per session)

Not a header strip: the model chip, thinking chip and context meter live in the
**composer footer** (`Composer.tsx`, right of the attach button), and the
session's ⋮ menu lives in the **top bar** (`app/TopBar.tsx` → `SessionMenu`).

- Model picker (from `get_available_models`, grouped by **family** by default so every route to one model sits under one header — toggleable to provider grouping, with `provider:`/`id:`/`name:`/`is:` search qualifiers, starred and recent rows; remember custom/local providers exist).
- Thinking-level selector: pi has **seven** levels — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`ALL_THINKING_LEVELS`, ascending; the order is load-bearing because clamping walks it). Which ones a model offers is per-model, not universal: a non-reasoning model has only `off`, a `null` in its `thinkingLevelMap` marks a level explicitly unsupported, and `xhigh`/`max` are opt-in (absent means unsupported, whereas absent for `off…high` means "provider default", i.e. supported). A live session prefers pi's own `get_available_thinking_levels`; the home picker, which has no session to ask, derives the same answer from `shared/thinking.ts`. The chip is hidden unless the model has more than one level — a chip reading "No thinking" over a one-item menu is noise.
- **Two owners, one chip.** `ModelPicker` drives a live session over RPC
  (`set_model`); `HomeModelPicker` has no process to talk to, so it reads and
  writes pi's own `defaultProvider` / `defaultModel` / `defaultThinkingLevel`.
  That split is deliberate. The chrome is not: both render
  `composer/ModelChip.tsx`, which owns the one-line layout and the rule that
  only a non-pi provider gets named. It was copy-pasted before, and drifted in
  both directions.
- Context meter: % of window from `get_session_stats` (poll after each `agent_end` + on demand); warn state near compaction threshold. Token/cost readout (input/output/cache split in a popover), plus the two sections below.
- Stop (`abort`) is the composer's send button while a turn runs. Everything else is in the ⋮ menu (`SessionMenu.tsx`): Export HTML… (save dialog → `export_html` → reveal/open), Compact now… (prompts for optional custom instructions; blank = default), then auto-compaction, auto-retry and the two queue-mode rows (Steering / Follow-ups, each showing its current mode — "All at once" / "One at a time" — and cycling to the other in place). Toggles keep the menu open — they are settings you may flip two of, not commands that take you elsewhere. Renaming is `/name` or the sidebar row, not this menu.

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

Five sources, three different confidence levels — and the UI is required to
keep them distinguishable, because they are not equally trustworthy.

| Section                 | Source                                                         | Shown for                         |
| ----------------------- | -------------------------------------------------------------- | --------------------------------- |
| Tokens / cost           | `get_session_stats`                                            | every session                     |
| Context composition     | `phosphor-context-breakdown` status key (bundled extension)    | every session                     |
| Optimization · Headroom | `phosphor-headroom` status key (bundled extension)             | sessions that compressed a result |
| Plan usage              | `claude:usageSnapshot` IPC — `claude -p /usage`, live percents | Claude Code provider sessions     |
| Plan limits             | `claude-rate-limit` status key (provider ≥0.4.5)               | Claude Code provider sessions     |

**Wide, not tall** (redesigned 2026-09-07). Six stacked
single-column sections grew the panel past 1000px on a real session, and it
anchors upward from the composer — so the overflow clipped its own heading off
the top of the window. It is now 27rem wide with the composition legend,
Tokens/Session and the plan windows each in a row rather than a stack, ~500px
tall on the same data, and its body scrolls as a backstop for a short window.
Adding a section means finding it a column, not another 100px — Headroom's
savings are one full-width row with the total in its own header, not three
labelled rows in a 190px column where every value would have wrapped.

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

**Not every provider reports usage while it streams**, and the live meter has
to survive one that doesn't. `src/lib/liveStats.ts` takes the context estimate
from the newest true reading: the streaming message when its deltas have
reported anything, else the last message to have **ended** since the last poll.
The second arm exists because the OpenAI Responses API (`openai-codex` —
GPT-5.x/GPT-6 on a ChatGPT subscription) fills usage only on its terminal
`response.completed` event, so its `message_update` frames carry a
present-but-zeroed usage object. Present was enough to flip `hasUsageDeltas`
and switch off mid-turn polling; zeroed was not enough to move the meter. A
codex session then read **0% for a whole turn of 95 tool calls and 5.7M
cache-read tokens**, and the composition rows were crushed ~100× with it,
because they are clamped down to fit that total. `message_end` carries
authoritative usage on every provider and pi emits one assistant message per
tool hop, so the fallback costs no round trips. A poll clears the banked
reading, which is what keeps a post-compaction reset from being overridden.

**Context composition** answers "full of _what_" — messages, system prompt,
tool schemas, MCP tool schemas — which pi's single `contextUsage.tokens`
number cannot. Only that **total is authoritative**: component sizes are
character-based estimates (no tokenizer is reachable from an extension), the
popover labels them approximate, and free space is the honest remainder.

`breakdownSlices` scales estimates **down** to fit pi's total and never up.
The extension can only measure pi's own state, and under a CLI provider that
is a minority of the request: the Claude CLI sends its own system prompt and
its own native tool schemas, and keeps native tool results in its own
transcript. Scaling up assumed every token pi counts belonged to something we
measured, so the CLI's hidden share was added to _our_ rows — a fixed
9,914-token system prompt rendered as 44.1k then 22.5k across four turns of
one session, while the same code stayed within ~8% on a native pi session
(measured 2026-09-09). The remainder is
its own **Unmeasured** slice instead. Never fold provider-side context into a
row that names something else, and never let the parts sum past the total.

**MCP servers** breaks the MCP slice down per connector, as chips (name +
tokens), because the single slice cannot say which server to disconnect. What
it counts is the schema actually in the window, which under the gateway is
**one proxy tool per server** (`mcp__<server>`, ~700 tokens) — the server's own
tools are fetched on demand by `mcp` search/describe and are not carried in
context. A server with `directTools` is the exception: its tools are promoted
flat and every schema lands in the window, which is where a chip goes from
hundreds of tokens to tens of thousands. See
[mcp.md](mcp.md#the-claude-provider-reaches-mcp-through-pi-not-around-it).

The total stays load-bearing even now that estimates are no longer scaled up
onto it — it sizes the Unmeasured slice — and it is worth knowing how it
failed. Until `pi-claude-cli` 0.4.10, a Claude session's
`contextUsage.tokens` was the episode's **summed billing**, not its context:
pi derives context from `usage.totalTokens`, and the provider set that to
input + output + cacheRead + cacheWrite across every cycle of the turn, so
the cached prefix was counted once per API round trip. A 4-call turn read
277k against a real 78k; a 26-call turn read 2.08M against a real 104k. The
composition rows inherited the error exactly, because they were scaled onto
that total — which is how a lane came to report a 146k system prompt. Today
that failure lands in Unmeasured instead: a component row is what the
extension measured, so an absurd **total** or a dominant **Unmeasured** slice
is evidence about the provider's `totalTokens`, not about the estimate.

**Plan limits** is account state, not session state: the window
(`five_hour`), when it resets, whether the account is capped or on overage,
and — from provider 0.4.9 — how much of that window is consumed. Older
providers send the window and its reset without a percentage, so the bar is
omitted rather than guessed; `utilization: null` and "none used" must never
look the same. It renders only when the key is present, so other providers
show nothing rather than an empty section.

**Plan usage** renders one dial per window — arc for the proportion, percent
inside it, short window name and a compact countdown (`4h 18m`) beneath. Three
windows therefore cost one row instead of three, and the arc reads without
being read. **Refresh** re-runs `claude -p /usage` past main's 60 s cache
(`force` on the channel, honoured for no other caller): a refresh that returns
the cached answer looks broken, while an uncached read on every popover open
would hit the endpoint's own rate limit.

It reads the lane's OWN account (`claude:sessionAccount` →
`claude:usageSnapshot <id>`) and names it once more than one Claude login is
configured; the rate-limit banner names it too. Asking without an id read
whichever credential the CLI keeps by default, which on a multi-account install
is routinely a different plan than the lane is spending. **Switch account**
lists every other signed-in login and moves this lane to the one picked, held
accounts included and marked — a hold comes from a cached reading, and the
person watching a stuck lane knows more than the cache does. It is offered
whenever a second account exists, not only when the current one is spent; when
it IS spent, the line above says which account new sessions go to instead. The
move is a respawn, not a switch: a running lane's credential was fixed when pi
spawned, so the lane is disposed and resumed from its own session file against
the new account, and the next turn re-reads the whole thread. The target list is
fetched when the picker opens, never on popover open — `claude:accounts` runs
`claude auth status` once per account.

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
