# Phosphor verified against pi 0.85.1, and the drift banner was 7 minors stale

Fable 5.1 was missing from the model menu. Not a Phosphor bug: the menu is pi's
own catalogue, re-exported per provider (`pi-claude-cli` maps
`getModels("anthropic")`), and the machine had pi **0.84.1**, whose bundled
`@earendil-works/pi-ai` catalogue has 13 Anthropic ids and no
`claude-fable-5-1`. pi 0.85.1 adds it. So the fix was an upgrade, and the
question behind the question was whether Phosphor is actually verified on the pi
it tells you it is verified on.

It was not. `AboutTab` had `VERIFIED_PI_MINOR = 78` while `MIN_PI_VERSION` had
moved to `0.84.1` — seven minors apart. Anyone on a supported pi got the
"newer than tested" warning as permanent furniture, which is how a real drift
warning stops being read.

## What 0.85 actually changed for Phosphor

Nothing in the wire contract. Diffed against 0.84.1 and 0.84.4:

- **Commands**: pi's RPC switch has 33 cases. `shared/rpc.ts` mirrors all 33.
  The only addition since 0.84.1 is `clear_queue` (0.84.4), already mirrored
  and already gated by `CLEAR_QUEUE_MIN_PI`.
- **Events**: `dist/core/agent-session.d.ts` declares the same 14 event types
  in 0.84.1 and 0.85.1. None added, none removed.
- **Response shapes**: `rpc-types.d.ts` and `json-event.d.ts` differ from
  0.84.1 only by the 0.84.2–0.84.4 changes Phosphor already reads (`usage` on
  `message_update`, id + `toolName` on `toolcall_start`, `clear_queue`).
  `SessionStats` and `ContextUsage` in `shared/rpc.ts` match field for field.

Of the release's own notes, one item is a straight win for Phosphor: 0.85.0 fixed
`abort` reporting success without cancelling an in-progress manual compaction.

`MIN_PI_VERSION` therefore stays at `0.84.1`. Nothing Phosphor needs is 0.85-only,
and raising a floor with no reason behind it just strands installs.

## How it was verified

`npm run validate` is green on 0.85.1 (typecheck, lint, format, unit, e2e).
That is necessary and not sufficient: the e2e suite speaks to
`e2e/fixtures/pi-stub.cjs`, so it cannot see a real protocol change. The real
check is now a script — `node scripts/pi-live-smoke.mjs` — which spawns a live
`pi --mode rpc` the way `electron/pi/rpc-client.ts` spawns one (same argv, all
five bundled `pi-ext/` extensions, `PI_CLAUDE_CLI_STRICT_MCP=1`, the Claude
provider) and drives the surface Phosphor depends on. It runs one real model turn,
so it costs a few cents and stays out of `validate` and out of CI. All green:

- `get_state`, `get_available_models` (512 models; `claude-fable-5-1` present
  on `pi-claude-cli` and on three Bedrock profiles), `get_available_thinking_levels`,
  `get_commands`, `get_messages`, `get_entries`, `get_tree`, `get_session_stats`,
  `get_last_assistant_text`, `bash`, `clear_queue`, `set_session_name`,
  `set_thinking_level`, `set_model` to `claude-fable-5-1`.
- A real turn, streaming the full event sequence — `agent_start`, `turn_start`,
  `message_start`, `message_end`, `message_update`, `tool_execution_start`,
  `tool_execution_update`, `entry_appended`, `tool_execution_end`, `turn_end` —
  with 37 `message_update` deltas and a nested `toolcall_start` carrying both
  `id` and `toolName`. Zero JSONL parse errors.
- `get_session_stats` populated end to end, including `contextUsage`
  (`{tokens: 36170, contextWindow: 200000, percent: 18.085}`).
- All three extension-fed UI surfaces reported in on the status channel:
  `phosphor-context-breakdown`, `phosphor-mcp-status`, `mcp` (bundled extensions)
  plus `claude-rate-limit` and `claude-subagents` (the provider package).

`entry_appended`, `session_info_changed` and `thinking_level_changed` are
emitted by pi and handled nowhere in Phosphor. Pre-existing — all three exist in
0.84.1 too — and harmless, since `handleLine` forwards unknown records and the
reducer ignores what it does not know. Noted here so the next re-verification
does not rediscover it as a 0.85 regression.

## The banner

`VERIFIED_PI_MINOR` moved out of the component into
[`src/lib/piDrift.ts`](../../src/lib/piDrift.ts) as `VERIFIED_PI_LINE = '0.85'`,
with `isPiNewerThanVerified()` unit-tested beside it. The extraction is not
only tidiness: the old predicate read `Number(version.split('.')[1] ?? 0)`, so
pi **1.0.0** would have compared as minor 0 — older than the verified line —
and silenced the banner permanently at exactly the release where drift matters
most. The helper compares the `major.minor` pair, treats a patch of the
verified line as no drift, and stays silent on any version it cannot parse.

**When you bump this**, bump it because `scripts/pi-live-smoke.mjs` came back
green on the new pi, not because the number looked old.
