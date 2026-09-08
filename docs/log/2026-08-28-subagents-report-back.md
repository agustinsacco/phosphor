# 2026-08-28 — sub-agents report back, and a fan-out stops lying about itself

Prompted by "this agent just kind of stopped. when agents come back do they
communicate properly with pi?"

They did not come back at all. Six weeks of notes in this repo
([2026-08-22](2026-08-22-claude-subagents-never-return.md),
[2026-08-27](2026-08-27-subagent-burn-and-fake-context.md)) treated that as a
property of the CLI. It was not. It was one `SIGKILL` in the provider, and
everything Phosphor had built on top of it — the wording of a strip, the rows in
a transcript, a count in a summary — had hardened around the wrong cause.

## What the sessions showed

Session `01a04614` (Fable 5, ask-user-question worktree):

- The model launched 3 background agents. The CLI answered each in ~20 ms with
  "Async agent launched successfully… you will be notified".
- The model believed it, wrote "Now waiting on the three investigation
  agents", and ended its turn at `01:57:52.802`.
- The provider saw the CLI's `result` envelope and force-killed the process.
- All 3 sub-agent transcripts stop mid-tool-call at `01:57:50.0`, `:51.1` and
  `:52.4`. No final report, no `result`. They died with the CLI.
- The next turn replayed `task_notification status:"stopped"` for all three.
  pi learned they had died — one turn late.

Two minutes of work, three agents' worth of tokens, no deliverable.

## The measurement that changed the diagnosis

A probe held `claude -p` open past its first `result` instead of killing it
(`--include-partial-messages`, background `Agent` call, nothing written to
stdin afterwards):

```
+3.1s   TOOL_USE Agent (run_in_background: true)
+3.2s   TASK task_started local_agent
+8.7s   RESULT success            <- the provider used to SIGKILL here
+25.4s  TASK task_notification completed, summary carried the findings
+31.2s  TEXT "The agent found ..."   <- the CLI re-invoked the model itself
+31.4s  RESULT success            <- a second result, same episode
```

The CLI already implements the notification loop in print mode. The host owes
it nothing but patience. `modelUsage` across those two results is cumulative
for the session (cache-read 68,718 → 161,295), so waiting cannot double-count
tokens.

A second probe settled the shape of a foreground agent: `task_notification`
arrives BEFORE the result, so nothing is left pending and no turn hangs.

## Fixed in the provider (`@saccolabs/pi-claude-cli` 0.4.14)

- **A `result` with agents still running ends a CYCLE, not the episode.**
  Bounded by the inactivity timer (reset by every `task_progress`), a
  15-minute wall clock and 32 continuations. Both expiries end the turn on the
  content it already has — an error there would discard the model's own words.
  `PI_CLAUDE_CLI_NO_AGENT_WAIT=1` restores the old teardown.
- **Not every task is a sub-agent.** `task_started` carries `task_type`, and
  the CLI auto-backgrounds a slow `Bash` into a `local_bash` task wearing the
  tool's own description. One appeared as a fourth "agent" named `Search for
local source checkout of pi-claude-cli` in a three-agent fan-out. Only
  `local_agent` / `remote_agent` count now.
- **Not every notification belongs to this episode.** `task_notification`
  carries only `task_id`, and the tracker invented a description from it —
  `{"status":"stopped","description":"a8de7d982d824b56a"}`. Unknown ids are
  dropped.
- **Markers carry `task_id`**, so a host can join start to finish, and the
  description is clipped per-field so it stops eating `subagent_type`.
- **`AskUserQuestion` is no longer offered.** It renders a picker in the CLI's
  TUI and `-p` has none, so the call always returned "The user did not answer
  the questions." after a full round trip; session `01a04609` shows sonnet-5
  reading that as a refusal and falling back to "happy to discuss in plain
  text instead". Removing the tool gets the same prose question one round trip
  earlier.
- **The `claude-subagents` status key is cleared at episode end**, so live
  state stops outliving the turn it describes.

## Fixed here

- **One transcript row per AGENT, not per marker.** The CLI reports each agent
  three times (`Agent` call, `Task started`, `Task completed`). Phosphor rendered
  all three, so three agents became eight rows and a strip announcing "8
  sub-agents were started". `buildTranscriptRows` now folds them — by
  `task_id` when present, otherwise by pairing one marker per phase under a
  description, which keeps three same-named parallel agents as three rows.
- **A row claims only what its markers prove.** `launched` (tool called,
  nothing confirmed) is distinct from `running` (`task_started` seen), and a
  terminal row carries the agent's tool count, tokens and duration.
- **The strip counts evidence, not launches.** `trailingUnfinishedAgents`
  counts agents that never reached a terminal state. On 0.4.14 that is zero
  and the strip stays away; on an older provider every launch still qualifies
  and it says so. Phosphor pins no provider version, so both shapes keep
  arriving and neither is assumed.
- **`claude-subagents` is registered as a structured status key.** Until it
  was, `StatusStrip` printed the whole JSON payload along the bottom of the
  window (`…,"currentStep":"Running Read stream-parser…"`). It now parses into
  an agent chip.
- **The CLI transcript path was wrong everywhere it was used.** Observer mode
  gives the CLI its own session id and records the pairing in a sidecar map;
  Phosphor still derived the path from the pi session id. That broke the debug
  block a user pastes into a bug report, and the second half of a session
  delete — every deleted Claude session left its CLI transcript behind, which
  is megabytes each. `electron/pi/claude-session-map.ts` reads the map;
  a miss falls back to the pi id, which is still right for pre-observer-mode
  sessions.

## What is still true

The sub-agent's own transcript is not forwarded — everything tagged
`parent_tool_use_id` stays inside the CLI. A row's expandable detail is the
launch PROMPT, never the agent's work. Surfacing more needs a provider change
first (its `docs/ARCHITECTURE.md` names the seam).

The fix is not live until 0.4.14 is published AND reinstalled into pi:

```bash
jq -r .version ~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/package.json
npm view @saccolabs/pi-claude-cli version
```
