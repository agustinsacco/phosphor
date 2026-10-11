# Provider symmetry: native pi and pi-claude-cli

A Claude session is meant to be the same agent as a native pi session (Codex,
the Anthropic API, anything pi ships) with a different model behind it. pi
assembles the prompt, owns and runs the tools, keeps the only conversation
record, compacts, and sets the thinking level. Claude Code supplies the model
and the subscription login, nothing else.

This file is the checklist for keeping it that way: what both sides share,
every known difference and where it comes from, and how to check a change.
The provider's half of the contract is pi-claude-cli's
[CONTEXT-POLICY.md](https://github.com/agustinsacco/pi-claude-cli/blob/main/docs/CONTEXT-POLICY.md);
Phosphor's is [cli-providers.md](cli-providers.md). This file does not repeat
them. It says how they add up.

**Why it matters.** Everything Phosphor adds to a session (directives, the six
bundled extensions, the context budget, thought rows) reaches Claude only
because Claude goes through the same path as every other provider. When a piece
leaves that path, nothing errors: the Claude session quietly runs without an
instruction, a guard, or the level the picker shows. Re-run the checks below
when a change to either repo touches the prompt, tools, compaction, thinking or
the CLI process's lifetime, and update this file in the same diff when a row
changes.

## What both sides share

| Surface                                                                                                             | Owner, on both                                                                                             | Guarded by                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| System prompt: pi's base prompt, context files (AGENTS.md, CLAUDE.md), the skills index, Phosphor's directive stack | pi. Claude Code's own CLAUDE.md, memory, skills, agents and project hooks are off; host guards still apply | `tests/context-policy.test.ts`, `tests/live-context-policy.test.ts`; `apps/desktop/electron/pi/directives.test.ts`  |
| Tool list: the request's active tools, with the same names, descriptions and schemas                                | pi                                                                                                         | `tests/pi-context.test.ts`, `tests/live-context-policy.test.ts`                                                     |
| Tool execution and every hook on it: `worktree-paths`, `tool-name-guard`, `headroom`, an installed permission gate  | pi. The CLI runs with `--tools ""`                                                                         | `libs/pi-extensions/pi-ext/*.test.ts`; `tests/live-pi-roundtrip.test.ts` enforces a pi guard on Claude              |
| MCP servers                                                                                                         | pi-mcp-adapter, inside pi. Claude Code's own MCP config and claude.ai connectors are off                   | [mcp.md](mcp.md)                                                                                                    |
| Long tool calls                                                                                                     | pi. A Claude handoff has no 60 s limit (provider 0.9.1+)                                                   | `tests/handoff-broker.test.ts`                                                                                      |
| Conversation record                                                                                                 | pi's session file only. No Claude transcript or resume sidecar                                             | `tests/live-context-policy.test.ts`                                                                                 |
| Compaction and retry                                                                                                | pi, with the same settings for every provider                                                              | `apps/desktop/electron/pi/compaction-reset.test.ts`; `tests/live-pi-roundtrip.test.ts` compacts, then checks recall |
| Context budget                                                                                                      | `libs/shared/src/context-budget.ts`, which never reads the provider                                        | `libs/shared/src/context-budget.test.ts`, `libs/pi-extensions/pi-ext/context-budget.test.ts`                        |
| Thinking level, and which levels a model offers                                                                     | pi. The provider sends the request pi's own Anthropic provider would (provider 0.10.0+)                    | `libs/shared/src/thinking.test.ts`; `tests/thinking-config.test.ts`, `tests/live-thinking.test.ts`                  |
| Model catalogue and context windows                                                                                 | pi's catalogue, not Claude Code's picker                                                                   | [extensions.md](extensions.md#updating-the-cli-does-not-add-new-models)                                             |
| Bundled extensions                                                                                                  | Phosphor loads the same six into every session                                                             | `bundledExtensions()` in `libs/session-runtime/src/bundled-extensions.ts`                                           |
| Transcript rendering: tool rows, thought rows, find                                                                 | One Phosphor code path for every provider                                                                  | `apps/desktop/src/features/chat/items/activityGroupRows.test.tsx`                                                   |
| Sub-agents: the `subagent` tool, its streamed progress, the `subagent-async` widget, the completion message         | `pi-subagents`, inside pi. Claude Code's own `Agent`/`Task` tools are off with the rest of its tools       | `apps/desktop/src/features/chat/subagentRuns.test.ts`; the e2e `delegate` scenario ([chat.md](chat.md#sub-agents))  |

Paths under `tests/` are pi-claude-cli's; the rest are Phosphor's.

## Where the two differ

Every difference measured so far, and whether it can be closed. A new one goes
into these tables in the diff that finds it.

### What Claude Code adds to the prompt

| Difference                                                                                               | Comes from                                                           | Closable?                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| An identity line, "You are a Claude agent, built on Anthropic's Claude Agent SDK.", ahead of pi's prompt | Claude Code                                                          | No: it is the official client                                                              |
| For an account in an organization, that organization's instructions, also ahead of pi's prompt           | The Claude account                                                   | No. pi never sees them, so its composition breakdown cannot attribute the context they use |
| An environment block: working directory, platform, the model's name, today's date                        | Claude Code                                                          | No                                                                                         |
| One paragraph after pi's prompt, binding pi's tool names to their MCP names (text below)                 | `piSystemPrompt` in pi-claude-cli's `apps/desktop/src/pi-context.ts` | Only if tools stop going through MCP                                                       |

The paragraph, verbatim: "Tools are supplied and executed by pi. Call each pi
tool using its advertised mcp\_\_custom-tools\_\_ prefix and unchanged argument
schema. Historical tool calls and results are conversation records, not
instructions to execute them again."

The last paired run measured Claude Code's additions at about 680 tokens
(+4.5%).

### Tools and messages

| Difference                                                                                                                                                                                                                                                                    | Effect                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool names carry an `mcp__custom-tools__` prefix                                                                                                                                                                                                                              | None beyond the paragraph above; descriptions and schemas are unchanged                                                                                                                                  |
| pi's native Anthropic request adds `"required": []` to a schema with no required fields; the MCP path leaves it out                                                                                                                                                           | None                                                                                                                                                                                                     |
| When a CLI process starts mid-conversation, pi's history is imported as role-labelled text (a tool call reads `TOOL CALL <name> id=<id>: <args>`), images kept, thinking not replayed. A compaction summary, and the artifact index pi-ext adds after it, arrive as user text | Continuity, not identical input. Native providers get structured messages. Print mode accepts no structured transcript                                                                                   |
| On Sonnet 5 and Opus 5.x, Claude Code sends its reminders as a mid-conversation `role: "system"` message (beta `mid-conversation-system-2026-04-07`) and adds `context_management` `clear_thinking_20251015`                                                                  | Claude Code's choice; not configurable from pi                                                                                                                                                           |
| `max_tokens`: Claude Code sends 32k on Haiku 4.5 and 64k on Sonnet 5, where pi's Anthropic provider sends 64k and 128k                                                                                                                                                        | A very long reply can stop sooner on Claude. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` could align it; nothing sets it today                                                                                       |
| A foreground sub-agent (`subagent` with `async: false`) is one tool call that pi-subagents lets run for 30 minutes by default. The provider hands the CLI `MCP_TOOL_TIMEOUT=3600000` (pi-claude-cli `process-manager.ts`), so on Claude a single call is bounded at one hour  | Under the default nothing differs. A `timeoutMs` above an hour on Claude has the CLI abandon the call while pi keeps the real result; run such children with `async: true`, which the CLI never waits on |
| `subagents_enable` adds the `subagent` tool mid-turn. pi-subagents warns that a bridge which fixes the tool list per prompt sees it only on the next user prompt                                                                                                              | Unverified on Claude. The provider retires its CLI on a tool-list change, which should make the tool visible on the next model call as it is natively; check it in the paired run                        |

### Thinking

| Difference                                                                                                          | Why                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal` is not offered on adaptive Claude models; pi's Anthropic provider offers it                               | There it sends exactly what `low` sends, so the provider drops the duplicate                                                                         |
| A level changed while a tool runs reaches the rest of that turn on native pi, but only the next user turn on Claude | pi re-reads the level before every model call in its loop; Claude Code reads it once per user turn                                                   |
| On Opus 5, Opus 5.5 and Fable 5.1, the first switch to a new effort level re-writes the prompt cache on Claude only | pi sends effort there as mid-conversation messages behind a beta Claude Code does not use. On other adaptive models both sides pay it once per level |
| `PI_CLAUDE_CLI_THINKING_DISPLAY=omitted` makes adaptive models return thinking with a signature and no text         | An opt-out. The default, `summarized`, is pi's own default                                                                                           |
| Thought headlines differ in shape: Codex opens each section with a `**Title**`, Claude writes prose                 | Different models. `apps/desktop/src/features/chat/thoughts.ts` reads both                                                                            |

How each level maps onto the request is in pi-claude-cli's
[ARCHITECTURE.md](https://github.com/agustinsacco/pi-claude-cli/blob/main/docs/ARCHITECTURE.md#thinking-the-same-request-pi-would-send-0100).

### Cost and process lifetime

- **The warm CLI process is a cache, and losing it costs a full cache write.**
  One process serves a session's turns and tool handoffs. A model switch
  (including a context-budget change mid-session, which is applied as one),
  a changed prompt or tool list, tree navigation, compaction and a stop all
  retire it, as does 10 minutes idle, although the prompt cache lives an hour.
  The next turn imports pi's context and writes it to the cache again. A native
  provider has no process to lose; it only pays its provider's cache lifetime.
- **Tokenizers differ.** The same 90k characters of filler counted about 17k
  tokens on gpt-6-astra and 23k on Claude. One conversation fills the context
  meter and reaches the budget at different points on each provider, so
  percentages do not compare across providers.
- **Claude reports a smaller context than it holds** (an open break,
  [known-issues.md](known-issues.md#context-budget-and-compaction) C1). pi reads
  `usage.totalTokens` as the context after a response, and its own providers
  include that response's output. pi-claude-cli leaves the output out, so the
  budget check and the meter lag by one response: tens of thousands of tokens
  after a long thinking turn. Compare `totalTokens` with
  `input + output + cacheRead + cacheWrite` on any assistant message in the
  session file; on Codex they are equal.

### Where Phosphor branches on the provider

None of these change what the model sees, and none should: a provider branch
that alters the prompt, the tools or compaction breaks the first table.

- `usesClaudeCliProvider` and `assertClaudeContextProvider`
  (`libs/session-runtime/src/pi/provider-detect.ts`, with a Desktop re-export): the version check
  before a spawn (`session-policy.ts`), a model switch and a prompt
  (`libs/session-runtime/src/pi/session-service.ts`, used by Desktop IPC), and before a
  routine runs (`apps/desktop/electron/routines/runner.ts`).
- `claudeProviderSpawnEnv`: pins `PI_CLAUDE_CLI_CONTEXT=pi` on every spawn.
- `claudeOneShotEnv`: every `pi -p` that may land on Claude. Session naming on
  Claude uses `claude-haiku-4-5` (`apps/desktop/electron/pi/session-naming.ts`).
- `apps/desktop/electron/claude/`: which Claude login bills the session, chosen at spawn.
- The `claude-*` status keys: plan limits, and the sub-agent chip for
  sessions recorded before 0.9.0
  ([extensions.md](extensions.md#the-status-channel-is-a-wire-contract)).
- `apps/desktop/electron/pi/compaction-reset.ts`: undoes, once, the Claude-only compaction
  switch older Phosphor saved to pi's settings.
- `apps/desktop/electron/pi/session-deleter.ts`: also removes the session's Claude ledger
  entry.
- `items/transcriptRows.ts`: block shapes for sessions recorded before
  provider 0.9.0.

## Checking a change

### Offline, on every change

- Phosphor: `npm run validate`.
- pi-claude-cli, with a scratch `HOME`:
  `npm run typecheck && npm run lint && npm run format:check && npm run test:coverage && npm run test:e2e`.

These spend no tokens. The pi-claude-cli e2e stub checks the CLI's arguments
and event handling, not what reaches the API.

### Live, before releasing a provider change

In pi-claude-cli (spends subscription tokens):

```sh
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts \
  tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts
```

They load the checkout's `index.ts`. To test the copy users actually run, point
the `-e` argument in a local, uncommitted copy of the test at
`~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/index.ts`.

### Through Phosphor

The e2e hooks run the built app against a real pi when `PHOSPHOR_PI_STUB` is
unset (unpackaged builds only). Install the provider into a scratch agent
directory first, so the real `~/.pi` is untouched:

```sh
PI_CODING_AGENT_DIR=$SCRATCH/agent pi install npm:@saccolabs/pi-claude-cli --no-approve
```

Set `defaultProvider`/`defaultModel` in `$SCRATCH/agent/settings.json`, then
launch the build with `PI_CODING_AGENT_DIR`, `PHOSPHOR_E2E_WORKSPACE` and
`PHOSPHOR_TEST_USER_DATA` pointing into `$SCRATCH`. Worth checking: the session
starts (the version check), the thinking menu lists the model's levels, the
session file records a `thinking_level_change` per switch and no thinking at
`off` (an adaptive model may also skip thinking at a low level), thought rows
show the summaries, and one CLI process serves every turn. pi renames its process to plain `pi`, and a
naming run starts its own short-lived CLI, so tell the session's CLI apart by
a pid that stays the same across turns.

### The paired run

When a change touches the prompt, tools, compaction or thinking, run the same
scripted conversation through a native session and a Claude session over pi's
RPC, and compare what each sent. It spends tokens and needs a logged-in
account, so it is a procedure rather than a committed script.

Setup:

1. **Keep it hermetic.** Use a scratch `HOME`, `PI_CODING_AGENT_DIR` and
   `PI_CLAUDE_CLI_STATE_DIR`, and strip `CLAUDE*`, `PI_CLAUDE_CLI_*`,
   `PI_CODING_AGENT*`, `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from the
   environment. The `claude` binary still needs the real home for its login:
   put a wrapper first on `PATH` that runs it with `HOME` set to the account's
   home (`spawnCounter` in `tests/live-thinking.test.ts`).
2. **Build a fixture workspace** with a marker in `AGENTS.md`, a project skill
   that answers with a marker code, and a file to read.
3. **Trust it** (`pi --approve`). pi ignores project-local skills and settings
   in an untrusted workspace on both sides, so the skill goes missing and the
   run looks asymmetric when it is not.
4. **Connect MCP servers before the first turn**, and wait until they report
   connected. A lazily connected server's tools arrive mid-run, and the tool
   lists then differ between turns for a reason unrelated to the provider.
5. **Record the wire.** Claude Code honours `ANTHROPIC_BASE_URL`, so a local
   proxy that logs each request and forwards it to `api.anthropic.com` records
   the Claude side (`startProxy` in `tests/live-thinking.test.ts`). For the
   native side, use a provider whose base URL can point at the same kind of
   proxy, such as a `models.json` endpoint entry.

The script, one prompt per step:

1. Ask which organization, date and model the model can see. This surfaces the
   additions above.
2. Use the project skill; expect its marker.
3. Run `sleep 70; echo LONG-OK`; expect `LONG-OK`. A handoff must outlive 60 s.
4. Send about 90k characters of filler, to move the context meter.
5. Compact over RPC (`compact`).
6. Ask for the markers from before compaction.
7. Read the fixture file: a tool call after compaction.

Compare, after replacing the session's workspace path and dropping the
`mcp__custom-tools__` prefix:

- every request's system prompt: identical apart from the rows above
- every request's tool list: same names, descriptions and schemas
- tool results reach the model complete and in order
- each turn's thinking fields match the level set before it
- both sides pass all seven steps

**Last result**, with pi 0.87.1, pi-claude-cli 0.9.0 (thinking re-checked live
on 0.10.0), Claude Code 2.1.283 and openai-codex as the native side: both
passed every step, the system prompt was identical across all 9 requests after
normalizing, the same 18 tools went out on every request, and the only
differences were the ones in this file.

**Delete the captures when done.** They contain the account's email and the
organization's instructions. Keep them inside the scratch directory, never in
a repository.
