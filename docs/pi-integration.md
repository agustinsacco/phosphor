# 02 — pi Integration Reference

`MIN_PI_VERSION` is **1.2.0**. The context budget relies on pi's native
between-tool-cycle compaction (0.87.1+), verified with a real RPC process and a
local fake provider. Phosphor reads three 1.x fields: a prompt's
`data.disposition` (`handled` means an extension command consumed it and no run
starts, so the composer drops its optimistic bubble and booting strip),
`agent_settled.aborted` (a lane that was stopped gets no "finished" notice) and
`durationMs` on `tool_execution_end` and tool results (a bash row's time, also
after a reload). Tool events with `parentToolCallId` are calls another tool made,
such as a codemode script's; the chat reducer and routine outcomes ignore them,
since no assistant message holds them. The protocol mirror in
`libs/shared/src/rpc.ts` was last re-verified against **1.2.0**, with
pi-claude-cli 0.10.0: every command and its fields match `rpc-types.d.ts`,
every event and content type it names is one pi emits, and the live smoke below
passed. Usage and tool-call identity fields remain
optional for historical records. The 0.84.0 streaming-shape change is in that
file's header. See [One context budget](cli-providers.md#one-context-budget) for
the session-local window cap.

When re-verifying against a new pi, diff `libs/shared/src/rpc/*.ts` (behind the `rpc.ts` facade) against pi's command switch and `dist/modes/json-event.d.ts` (the stdout shape), not just against `rpc-types.d.ts` (the internal shape):

```
$(npm root -g)/@earendil-works/pi-coding-agent/docs/rpc.md            ← the protocol, read fully
.../docs/sdk.md, session-format.md, settings.md, usage.md, extensions.md, skills.md
.../dist/modes/rpc/rpc-types.d.ts                                     ← exact command/response types
.../dist/core/tools/*.d.ts                                            ← tool input/details schemas
.../examples/extensions/  and  .../examples/rpc-extension-ui.ts       ← extension + client patterns
```

Then run `node tools/scripts/pi-live-smoke.mjs`, which drives a real `pi --mode rpc` through the commands, events and response fields Phosphor reads, and update `VERIFIED_PI_LINE` in `libs/client-ui/src/lib/piDrift.ts` (the About tab's drift banner) once it is green. `npm run validate` cannot substitute: its e2e suite talks to `apps/desktop/e2e/fixtures/pi-stub.cjs`, which answers a fixed script and cannot notice that pi's real protocol moved.

## Process model

- Spawn `pi --mode rpc` with `cwd` = the workspace folder. **One subprocess per live session.** Idle/old sessions are read from disk (see §Sessions on disk), not kept as processes.
- Useful flags, all of them assembled in `libs/session-runtime/src/pi/rpc-client.ts`: `--session <path|id>`, `--session-id <id>`, `--fork <path|id>`, `--no-session`, `--no-context-files`, `-n <name>`, `--model <pattern>` (supports `provider/id` and `:<thinking>` suffix), `--provider`, `--thinking <level>`, `-e <extension.ts>`, `--append-system-prompt <text|file>`.
- Spawn-argv logging preserves `--append-system-prompt` but replaces the following
  value with `[redacted]`; it does not log the composed directive text.
- `-e` is repeatable and every session gets **six** of them — Launch preparation in `libs/session-runtime/src/pi/session-launch.ts` resolves `bundledExtensions()`, and `libs/session-runtime/src/pi/session-policy.ts` passes `artifacts.ts`, `context-breakdown.ts`, `worktree-paths.ts`, `tool-name-guard.ts`, `headroom.ts`, `lane-reload.ts` from `libs/pi-extensions/pi-ext/`. They ship unpacked next to the app resources (`extraResources` in `apps/desktop/electron-builder.yml`) because the pi subprocess reads them off disk, not out of the asar. What each one is for: [extensions.md](extensions.md#bundled-extensions-phosphors-own).
- **Framing is strict JSONL, LF only.** Do NOT use Node `readline` (it also splits on U+2028/U+2029, which are legal inside JSON strings). Buffer on `\n`, strip a trailing `\r`. `JsonlDecoder` scans only new chunks and joins an incomplete record's fragments once at its delimiter or stream end, so framing work is linear in input size. Commands go to stdin one JSON object per line; responses and events stream from stdout. The explicit `node tools/scripts/perf/stream-buffers.mjs` benchmark measures framing and PTY-tail costs without running a model.
- Commands accept optional `id` for correlation; responses echo it. Events never carry `id`.
- pi requires Node ≥ 22.19 (it runs as its own process, so Electron's Node version is irrelevant).
- **`pi -p` blocks until stdin reaches EOF, so it is never run through
  `execFile`/`exec`.** Both leave the child's stdin an open pipe, and pi then sits
  there until the caller's timeout, silently, with empty stdout and stderr. That
  killed session auto-naming for weeks: no session was named and no branch
  renamed. Print-mode runs spawn through `apps/desktop/electron/pi/print-mode.ts`
  (`stdio[0] = 'ignore'`). The e2e stub prints and exits without reading stdin,
  so it cannot catch a regression; `print-mode.test.ts` is the guard.

Desktop's `apps/desktop/electron/pi/session-runtime.ts` binds the shared session service.
`libs/session-runtime/src/pi/session-service.ts` admits create/resume and manual commands;
`session-startup.ts` owns preparation/readiness and failure disposal. Live budget
and routine callbacks remain live, while provider/account environment is fixed
at spawn. Resume, deletion and Phosphor's own transcript edits share one
owner-local path-lock instance (§Sessions on disk covers the edits). The
Node subprocess test exercises this complete path without Electron, using a
fake pi, not a real provider.

## RPC commands (complete set — all 33 in `RpcCommand`, `libs/shared/src/rpc.ts`)

Every one drives a UI surface except `get_tree` and `get_fork_messages`: those
are mirrored so the type union stays whole and the `RpcResponseDataMap` guard
keeps covering it, but nothing reads them. The session tree is built from the
`.jsonl` on disk instead (see §Sessions on disk), which needs no live process.
And `get_fork_messages` is **not** a rewind list: it is every user entry in the
whole file (all branches, file order) that has text, so its indices do not line
up with the transcript. Phosphor once assumed they did, and forked from the
wrong message on any compacted or branched session. Rewind reads the current
branch from `get_entries` instead.

| Command                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                                                   | `message`, optional `images[]` ({type:"image", data: base64, mimeType}), optional `streamingBehavior: "steer"\|"followUp"` — **required** if agent is streaming, else the command errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `steer` / `follow_up`                                                      | queue messages during streaming (steer = after current turn's tool calls; follow-up = after agent finishes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `clear_queue`                                                              | **pi 0.84.4+** (above `MIN_PI_VERSION`; older pi answers `Unknown command`, queues untouched, and the chat error names the installed version plus the upgrade command — a session keeps the pi it spawned, so an upgrade only reaches a **new** session). Drains BOTH queues and returns what it drained — the only queue mutation pi offers, so removing one chip is drain + re-queue the survivors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `abort`                                                                    | stop current run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `new_session`                                                              | optional `parentSession` path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_state`                                                                | model, thinkingLevel, isStreaming, isCompacting, steering/followUp modes, sessionFile/Id/Name, autoCompaction, counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `get_messages`                                                             | full AgentMessage[] history (used on resume/attach)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `set_model` (provider, modelId) / `cycle_model` / `get_available_models`   | models = full Model objects (id, name, provider, reasoning, contextWindow, cost…)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `set_thinking_level` / `cycle_thinking_level`                              | off\|minimal\|low\|medium\|high\|xhigh\|max (`ThinkingLevel` in `libs/shared/src/rpc.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_available_thinking_levels`                                            | the levels the **current** model supports. Authoritative — ask, never infer from the model id. Called in the session-boot batch and again on every model switch (`refreshThinkingLevels`, `libs/client-ui/src/stores/sessions.ts`), with the list cleared first so the picker's local derivation covers the gap and a too-old pi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `set_steering_mode` / `set_follow_up_mode`                                 | "all" \| "one-at-a-time"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `compact`                                                                  | optional customInstructions; returns summary + tokensBefore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `set_auto_compaction` / `set_auto_retry` / `abort_retry`                   | toggles + retry cancel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bash`                                                                     | runs immediately, output enters LLM context **on next prompt**; `excludeFromContext` supported; result may be truncated with `fullOutputPath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `abort_bash`                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `get_session_stats`                                                        | tokens {input, output, cacheRead, cacheWrite}, cost, contextUsage {tokens, contextWindow, percent}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `export_html`                                                              | optional outputPath; returns written path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `switch_session` (path) / `fork` (entryId) / `clone` / `get_fork_messages` | session tree operations; fork/clone may be `cancelled` by extensions. For a persisted session both always branch onto a brand-new `sessionFile` (pi's own `SessionManager.createBranchedSession`, `dist/core/session-manager.js` — not a Phosphor class; do not grep for it here) and swap the live runtime onto it — never an in-place truncation — so a caller must re-`get_state` afterward to learn the new path — a caller still holding the pre-fork path keeps marking the abandoned file live, which surfaces as two identically-named sidebar rows — and the abandoned parent file stays on disk. Phosphor hides it only after a rewind it recorded (`features/sessions/rewound.ts`; see [lanes.md](lanes.md#forks-and-saved-history)), never because of the file's shape. `fork` replies with `selectedText` only: images on the rewound message are dropped, so the caller restores them from the entry it forks |
| `get_last_assistant_text`                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `set_session_name`                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `get_commands`                                                             | slash commands: `{name, description?, source: "extension"\|"prompt"\|"skill", sourceInfo?: {path, source, scope, origin, baseDir?}}` — `sourceInfo.source` is `npm:<pkg>` for a package, `local`/`auto` for a file, `inline` for pi's own extensions; the `/` menu renders it as the row's origin — invoke by sending `/name …` as a `prompt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_entries` (optional `since`) / `get_tree`                              | the live session's entry list (`since` = only entries appended after that id) and its branch tree. `get_entries` + its `leafId` is how rewind finds the current branch (`libs/client-ui/src/features/chat/rewind.ts`). Typed `unknown[]` on purpose: half-mirroring a recursive on-disk format is how this file drifted last time. The tree view reads the `.jsonl` over `sessions:readTree`, which works for idle sessions too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Events (stdout stream)

The full `PiEvent` union in `libs/shared/src/rpc.ts`:

`agent_start` / `agent_end` (all messages of the run, `willRetry?`) / **`agent_settled`** (`aborted`) · `turn_start` / `turn_end` (assistant message + toolResults) · `message_start` / `message_update` / `message_end` · `tool_execution_start` (toolCallId, toolName, args) / `tool_execution_update` (**partialResult is accumulated — replace, don't append**) / `tool_execution_end` (result, isError, `durationMs?`); all three carry `parentToolCallId?` on a nested call · `queue_update` (steering[], followUp[]) · `compaction_start`/`compaction_end` (reason manual|threshold|overflow; `willRetry` on overflow success) · `auto_retry_start` (attempt, maxAttempts, delayMs, errorMessage) / `auto_retry_end` · **`bash_execution_update`** · **`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`** · `extension_error`.

The five late additions (bolded above), and why they matter:

- **`agent_settled`** is the only authoritative "fully done". `agent_end` ends one _run_, and pi may continue immediately with a retry, a queued steer/follow-up, or compaction recovery — so `agentStartedAt` is set once at `agent_start` and one continuous timer spans the whole operation (`WorkingIndicator.tsx`). The reducer nevertheless finalizes at `agent_end` unless that run names a concrete reason to continue (`willRetry`, or a non-empty queue), because a pi build that never emits `agent_settled` would otherwise leave the session visibly streaming forever (`libs/client-ui/src/features/chat/reducer.ts`).
- **`bash_execution_update`** (`id?`, `delta`) is the streamed output of a direct RPC `bash` command — not a tool execution, so it does not arrive as `tool_execution_update`. Nothing renders it yet; `bash` results land whole.
- **`summarization_retry_*`** report the retry loop around branch-summary and compaction summarization. `summarization_retry_attempt_start` is two shapes on one type name: `source: "branchSummary"`, or `source: "compaction"` with a `reason`.

Unknown event types hit the reducer's `default` branch and are dropped, not thrown — which is why these were silently missing from the mirror for weeks instead of crashing something loudly. Re-verifying the union by hand is the only thing that catches the next one.

`message_update.assistantMessageEvent` delta types: `start`, `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end` (end includes full toolCall), `done` (reason stop|length|toolUse), `error` (aborted|error).

## Extension-UI sub-protocol (must be fully implemented)

Extensions (including the user's installed packages such as `pi-web-access`) call `ctx.ui.*`; in RPC mode these arrive as `extension_ui_request` on stdout:

- **Dialogs — client MUST reply** via stdin `{type:"extension_ui_response", id, …}`:
  - `select` (title, options[]) → reply `{value}` or `{cancelled:true}`
  - `confirm` (title, message) → reply `{confirmed: bool}` or `{cancelled:true}`
  - `input` (title, placeholder) → reply `{value}` or cancelled
  - `editor` (title, prefill) → reply `{value}` or cancelled
  - `select` / `confirm` / `input` may carry `timeout` ms — agent auto-resolves on expiry; client needn't track. `editor` has no `timeout` field at all, so an editor dialog waits forever: the UI must always offer a way out.
- **Fire-and-forget — render only**: `notify` (message, notifyType info|warning|error → toast), `setStatus` (statusKey/statusText → status strip entries), `setWidget` (widgetKey/widgetLines/widgetPlacement aboveEditor|belowEditor → widget slots around composer), `setTitle`, `set_editor_text` (prefill chat input).

Map to native Phosphor UI (`libs/client-ui/src/features/extension-ui/`): modal sheets for dialogs, toasts, status strip, composer widget slots. One `select`/`confirm` shape gets a dedicated surface — a permission gate asking to run a shell command, recognised by `commandApproval.ts` and rendered by `CommandApprovalSheet.tsx` ([extensions.md](extensions.md#command-approval-dialogs)). Phosphor still only relays the answer in the gate's own option strings; it is a renderer here, not a decider. This is the one place tool execution can pause, and it exists because a third party asked, not because Phosphor has a permission model (see [overview.md](overview.md#non-negotiables) §3).

## Message & tool model (what the chat renderer consumes)

- `AssistantMessage.content`: array of `{type:"text"}` / `{type:"thinking"}` / `{type:"toolCall", id, name, arguments}` blocks; `usage` has token counts + cost; `stopReason`: stop|length|toolUse|error|aborted (+ `errorMessage`).
- `ToolResultMessage`: toolCallId, toolName, `content` (text/image blocks), `details` (tool-specific), isError.
- `UserMessage.content`: string or (text|image)[] blocks.
- `BashExecutionMessage` (role `bashExecution`): from the RPC `bash` command / `!` input — command, output, exitCode, truncated, fullOutputPath, `excludeFromContext` (the `!!` variant).
- Additional roles in history: `custom` / `customMessage` (extension-injected; `display` flag), `branchSummary`, `compactionSummary` — render summaries as subtle system dividers.

### Built-in tools and their `details` payloads

| Tool    | Input                                                          | details / render notes                                                                         |
| ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`  | path, offset?, limit?                                          | truncation info; images come back as image content blocks                                      |
| `bash`  | command, timeout?                                              | truncation + `fullOutputPath`; stream via tool_execution_update                                |
| `edit`  | path, edits[{oldText,newText}]                                 | **`details.diff` (display diff), `details.patch` (unified patch), `details.firstChangedLine`** |
| `write` | path, content                                                  | —                                                                                              |
| `grep`  | pattern, path?, glob?, ignoreCase?, literal?, context?, limit? | matchLimitReached, linesTruncated                                                              |
| `find`  | pattern, path?, limit?                                         | resultLimitReached                                                                             |
| `ls`    | path?, limit?                                                  | entryLimitReached                                                                              |

pi's `ToolName` union (`dist/core/tools/index.d.ts`) has an **eighth**: `powershell`, the Windows shell tool, sharing `bash`'s input and details types exactly. `ToolCard.tsx` does not case on it, so it falls to the generic renderer — correct but plainer than the `bash` card it is a synonym for. Worth knowing before assuming a Windows transcript looks like a macOS one.

Unknown/extension tools (`direct` MCP tools, subagent tools, etc.) MUST render well generically: name, pretty-JSON args (collapsed), streaming output, error state. The exception proves the rule: Phosphor's own `artifact_create` / `artifact_update` / `artifact_edit` get cased cards in `ToolCard.tsx` because Phosphor ships the extension that emits them and therefore knows the shape.

## Main-process activity facts

Each `PiRpcClient` owns a `SessionActivity` tracker, updated before transport
writes and before responses/events reach consumers. It includes renderer and
routine requests, direct bash, compaction, retries, queued prompts, executing
tools, and blocking extension dialogs. Display-only status does not count as
work. Startup and failed writes remain uncertain until a fresh state response.

`agent_end` is not treated as settled: recovery or queued work can follow it.
A state response issued before newer activity cannot overwrite newer facts.
Older pi builds can establish idle state through a fresh `get_state`, but that
response cannot clear retries, direct bash, or dialogs it does not describe.
Quit/update approval consumes these facts in main; unknown work is treated as
busy. Approved shutdown rejects new work but permits inspection and aborts.
This does not introduce automatic suspension. See [updates.md](updates.md) for
confirmation behavior and remaining recovery limitations.

## Sessions on disk (drives the sidebar without spawning processes)

The Host mirrors pi 0.87.1 `buildSessionContext` messages in
`libs/session-runtime/src/pi/session-context.ts`. When pi changes, regenerate its
RPC goldens with `node libs/session-runtime/src/pi/__fixtures__/session-context/generate.mjs`:
it uses isolated copies outside the agent directory to avoid pi's legacy-session
migration, and rewrites only the disposable header cwd to isolate project resources.

- JSONL tree files: `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl`. Respect `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`.
- Line 1 header: `{type:"session", version:3, id, timestamp, cwd, parentSession?}`. All other entries have `id`/`parentId` (8-char hex) forming a **tree**; the current position is the leaf.
- Entry types: `message` (wraps an AgentMessage), `model_change`, `thinking_level_change`, `compaction` (summary, firstKeptEntryId, tokensBefore), `branch_summary` (fromId, summary), `custom` (extension state, not in context), `custom_message` (in context), `label` (targetId, label), `session_info` (name).
- Sidebar scan: parse header + last `session_info` + first user message + file mtime. Rows order by immutable header creation time (newest first), not mtime, so viewing or updating a session does not move it. Live-update via chokidar on the sessions dir.
- Sessions are deleted by trashing the `.jsonl` file.
- pi creates a session's file when the first user message is sent, then appends
  each entry as it lands (pi 1.2.0: a mid-turn `set_session_name` is on disk
  before the reply). A session disposed before its first prompt has no file. The
  scan lags the watcher's `awaitWriteFinish` and debounce, so every surface that
  shows a LIVE session's title prefers the chat store's `meta.sessionName` over
  the scanned `meta.name`, and a new session shows a placeholder sidebar row
  (`PendingSessionRow`) until the scan finds its file.
- The tree view's labels, branch jumps and forks (`sessions:appendLabel`, `sessions:jump`,
  `sessions:forkAt`) write pi's files from main, through
  `apps/desktop/electron/pi/session-mutation.ts` and inside the same path lock as resume
  and deletion. Edits and admissions of one transcript therefore run in call order.
  - A label or jump is refused, never forced, while a lane in this process owns the file.
    That covers a live lane, a disposing one (still registered until its process
    exits) and a routine's claim. Paths are compared canonically, so a symlinked
    spelling is caught too. It is also refused once the file is gone, so an append
    queued behind a deletion cannot recreate it. The renderer closes its own lane
    first; main does not do it for the renderer.
  - A fork is the deliberate exception. It reads the source and writes a new
    fresh-id file, and it may run while the source is live, so an open lane's tree
    can still fork. It copies only the source's complete LF-terminated lines: a live
    pi can leave a torn last line mid-append, and copying it would merge it with the
    fork's jump into one unreadable line. The call returns only once the new file
    holds its jump.
  - The protection is process-local: a pi that another process started (a terminal,
    the Host CLI) is not seen.

## Config on disk

- `~/.pi/agent/settings.json` — defaultProvider/defaultModel/defaultThinkingLevel, hideThinkingBlock, compaction{enabled,reserveTokens,keepRecentTokens}, retry{...}, steeringMode/followUpMode, theme, packages[], skills[]. Project overrides merge from `<ws>/.pi/settings.json`.
- `~/.pi/agent/models.json` — custom providers/models (the reference user runs a local OpenAI-compatible endpoint; **never assume Anthropic-only**).
- `~/.pi/agent/auth.json` — API keys/OAuth (never display secrets). Env vars like `ANTHROPIC_API_KEY` also work.
- `~/.pi/agent/skills/`, `prompts/`, `extensions/`, `themes/`, `AGENTS.md`; project `.pi/` equivalents.
- `~/.pi/agent/mcp.json` and, for a trusted project, `<ws>/.pi/mcp.json`: pi's built-in MCP servers ([mcp.md](mcp.md)).
- A package config that is **not** under `~/.pi/agent/` and must not be assumed to be: `web-search.json` for pi-web-access — `$PI_CODING_AGENT_DIR/web-search.json`, else `$XDG_CONFIG_HOME/pi/web-search.json`, else `~/.pi/web-search.json` (`apps/desktop/electron/pi/pi-paths.ts`, verified against pi-web-access 0.24.0).
- Every one of these is a **foreign** file: pi and its packages own the format. Phosphor edits them only on explicit user action, never as a side effect ([settings.md](settings.md)).

## pi philosophy (mirror it)

pi core deliberately excludes subagents, plan mode, todos, permissions, background bash — these arrive via extensions/packages. MCP is the exception: pi has it built in. Phosphor therefore: renders unknown tools generically and well, executes `get_commands` results as slash commands, implements the extension-UI protocol faithfully, and never hardcodes an assumption that only built-in tools exist.
