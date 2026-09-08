# 2026-08-27 — sub-agents that never reported, and a context gauge that counted round trips

> **Update 2026-08-28.** Section 1 is fixed at the root: the provider was
> killing the CLI at the turn's first `result` while the agents were still
> working. `pi-claude-cli` 0.4.14 treats that result as a cycle boundary —
> see [2026-08-28-subagents-report-back.md](2026-08-28-subagents-report-back.md).

A review of the day's live lanes, prompted by one plain observation: "the
claude-cli usage is really pushing on using sub agents, is this correct?"

It was three separate faults wearing each other's clothes. One is fixed in
this repo, two in `pi-claude-cli`, and one was a setting.

## 1. Every sub-agent launched that day was killed before it reported

Lane `i-need-you-to-do-a-thorough`, one turn, 14:20:14 → 14:28:04:

- 5 `Agent` calls at depth 1. The security agent spawned 2 more (depth 2).
- Between them, 352 `Bash` calls and 34 `Read` calls.
- All 7 transcripts end at `14:28:04.123Z` — the same millisecond. Every
  `.meta.json` carries `"stoppedByUser": true`.
- Not one finding reached the model that asked for it.

Lane `im-unable-to-right-click-and-see-menu` was the same fault in miniature.
The entire user-visible answer for that turn was _"Investigating in
background. Will report findings once the agent returns."_ Nothing returned.

This is [2026-08-22-claude-subagents-never-return.md](2026-08-22-claude-subagents-never-return.md)
still live, at seven agents instead of one. The mechanism is unchanged: the
provider runs `claude -p` as a per-turn model server, and a backgrounded
sub-agent dies with it.

**What was new.** Every one of those launches was async — the tool results
read "Async agent launched successfully". `Agent` backgrounds by default;
`run_in_background: false` is opt-in. And a synchronous sub-agent works fine
here: one `claude -p` invocation, agent launched with the flag, and the
result came back inside the turn (verified directly, twice). So the
capability was never structurally broken in Phosphor. Nothing was telling the
model which form to use.

Hence `subagentPolicy` in [directives.ts](../../electron/pi/directives.ts) —
a fourth layer-2 block, on by default, that says the harness does not outlive
the turn and asks for `run_in_background: false` when delegating is genuinely
warranted. Prose, so a bias rather than a guarantee.

The hard block exists if it is ever needed, and it was verified: the provider
reads `PI_CLAUDE_CLI_SETTINGS` and passes it as `--settings`, so a settings
file with `permissions.deny: ["Agent","Task"]` removes the tool from the
model's list outright — tested under `bypassPermissions`, the model reported
no such tool existed and `permission_denials` was empty. Phosphor sets that
variable nowhere. Left that way deliberately: banning a tool whose
synchronous form works is the wrong trade.

## 2. The context gauge was counting API round trips, not context

A lane reported **28% of a 1M window on its first turn**. It was using 7.8%.

pi derives context from `usage.totalTokens`
(`calculateContextTokens()` short-circuits on it). The provider set that
field to `input + output + cacheRead + cacheWrite`, all four cumulative
across the turn's API calls. Every call re-sends the same cached prefix, so
the prefix was counted once per call.

That turn made four calls:

| call | cache write | cache read | context that call |
| ---- | ----------- | ---------- | ----------------- |
| 1    | 32,659      | 27,509     | 60,168            |
| 2    | 571         | 60,168     | 60,739            |
| 3    | 16,461      | 60,739     | 77,200            |
| 4    | 657         | 77,200     | **77,857**        |

Summed: 225,616 read + 50,348 write, and pi's `totalTokens` was 277,255 —
matching the sums to the token. The error factor is the number of API calls.
The 26-call turn from fault 1 reported 2,081,075 against a real context of
103,640: 208% of a 1M window at 10% true occupancy.

**Not cosmetic.** `shouldCompact()` takes the same number. With compaction
enabled and `reserveTokens: 50000`, a 1M lane compacts at 950k of _fake_
context; a 200k-window lane crosses its 150k threshold on the first turn.
No lane in three days of history had actually compacted yet — checked — so
this was armed rather than sprung.

The composition rows inherited the error exactly, because `breakdownSlices`
scales the extension's estimates onto pi's total. That is where the
preposterous "System prompt 146k" came from: one wrong total, three wrong
numbers. Real value ~40k.

Fixed in the provider ([PR #20](https://github.com/agustinsacco/pi-claude-cli/pull/20)):
the four components stay cumulative, and `totalTokens` latches the newest
cycle's prompt.

## 3. Billing omitted every sub-agent

pi's reported usage for the seven-agent turn was **exactly** the main agent,
to the token: output 32,954, cacheRead 1,963,051. The sub-agents' 28.6M
cache-read tokens appeared nowhere. At the provider's own rate table that is
\$2.34 reported against ~\$24.64 spent, a 10.5x under-report — and the
runaway-burn detector reads the same stats, so a seven-agent fan-out cannot
trip it.

The CLI does account for this, in a field the provider was not reading.
`result.usage` is the main agent alone; `result.modelUsage` is per-model for
the whole episode. On a captured single-sub-agent episode:

| source                     | cache read  | cache write |
| -------------------------- | ----------- | ----------- |
| main agent (`usage`)       | 74,562      | 26,808      |
| sub-agent (own transcript) | 28,079      | 30,112      |
| `modelUsage` summed        | **102,641** | **56,920**  |

Exact. Billing now folds `modelUsage` (same PR), which also picks up the
haiku auto-titler that was invisible too.

The one honest number on that popover throughout was **Plan limits**, which
comes from the account's own rate-limit headers. Sub-agent spend reached it
server-side all along. When the token rows and that bar disagree, the bar
wins.

## 4. The setting that started it

`claudeSystemPrompt` was `pi`, which passes `--system-prompt` and replaces
Claude Code's prompt entirely. The `Agent` **schema** still ships, so the
model kept the "delegate broad sweeps" half and lost every bit of guidance
about when not to. pi's replacement tools section names six tools and
`Agent` is not among them.

That is why "how do I add a new claude account on Phosphor?" fanned out, and why
the same model in Claude Code's own harness does not. Reverted to `claude`
(Phosphor's default, and the provider's). Costs ~12k context per call, cached at
0.1x.

## Also fixed here

- **An interrupt left no trace.** The debug log recorded the spawn and pi's
  stderr, so a killed turn looked exactly like a finished one. `abort` and
  `abort_bash` are now logged in [rpc-client.ts](../../electron/pi/rpc-client.ts).
  This is how the whole review nearly went wrong: `stopReason: stop` is what
  pi records for a user interrupt, and it was read as the model finishing.
- **`agentDirectivesByProject` did not merge defaults.** A stored per-project
  override predates any block added later, so an absent key read as "off"
  rather than "default". Merged per entry in [store.ts](../../electron/store.ts).

## What is still not fixed

Sub-agent **transcripts** remain invisible: the provider drops everything
tagged `parent_tool_use_id`, so there is still no progress, no result and no
tree in the UI, and the "N sub-agents were started but won't report back"
strip stays correct for the background case. Their tokens now show up; what
they did does not. The files exist on disk at
`~/.claude/projects/<mangled-cwd>/<claude-session-id>/subagents/agent-*.jsonl`
with `spawnDepth` and `parentAgentId` in a sibling `.meta.json`, so surfacing
the tree is possible without a provider change — it just needs the
pi-session-id → claude-session-id mapping, which the provider owns and does
not currently forward.

Nothing in either fix reaches this machine until 0.4.10 is published **and**
reinstalled into `~/.pi/agent/npm/`.
