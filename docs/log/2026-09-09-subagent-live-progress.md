# Every sub-agent row gets its own live step

_2026-09-09_

An eight-agent fan-out rendered as eight identical `running` rows for the eight
minutes it ran. The turn was not hung and the data was not missing — the live
step for every one of those agents was already arriving, already being parsed,
and then thrown away.

## Why the rows were frozen

Sub-agent rows are built from **markers**, and the provider emits exactly two
per agent: `task_started` and the terminal `task_notification`. That split is
deliberate and correct — `task_progress` fires once per sub-agent tool call
(~700 times in the incident that motivated the status channel), so folding it
into turn content would bury the transcript.

The consequence nobody closed: between those two markers a row has no new
information, so it cannot change. `SubagentBlock` has no field for a step and
no source for one.

Meanwhile `parseSubagentStatus` was parsing the full snapshot — every agent,
every step — and `summarizeSubagents` was keeping exactly one line of it for
the status strip, by design ("the newest running agent is the one the user is
waiting on"). With eight agents, seven live steps were parsed and dropped on
every tick.

## The fix

`findLiveSubagent(statusText, taskId)` joins the two halves that were already
in the same renderer. `SubagentBlock.taskId` and `SubagentTask.taskId` are the
same CLI id; nothing had ever put them together.

`SubagentRow` now renders the step on its own line, and lets the live snapshot
fill the cost fields (`toolUses` / `totalTokens` / `durationMs`) that markers
only carry at the end — so a running agent visibly climbs instead of sitting
blank until it finishes.

Three rules keep the row as honest as it was:

- **The overlay never moves a status.** A `launched` agent stays launched; that
  distinction is what tells a pre-0.4.14 session's dead agents apart from live
  ones, and it stays marker-fed.
- **A terminal row ignores live state entirely.** The provider clears the key
  when the episode ends, so a settled row must render from its markers or it
  would blank out. It is also why a stale snapshot cannot re-dress a finished
  agent.
- **Progress still never enters the transcript.** The join happens at render;
  nothing is persisted, and `task_progress` remains out of band.

Parsing is memoized on the payload string, because every row on screen asks the
same question about the same blob on the same tick.

`lastToolName` was added to `SubagentTask` — the provider publishes it and it
outlives `currentStep`, which the CLI clears between tool calls. It is the
fallback that keeps a row from flickering back to blank mid-flight.

## What this did not do, and what the review found

The sub-agent's own transcript is still not shown. But the review behind this
change corrected a claim that had been discouraging anyone from trying: the
provider's `task-tracker.ts` says a tree cannot be built because "no task
envelope names its parent," and `docs/extensions.md` said surfacing sub-agent
work needs a provider change first.

True of the event stream. False of disk. The CLI writes every sub-agent a
complete, live-appended transcript at
`~/.claude/projects/<mangled-cwd>/<session-id>/subagents/agent-<taskId>.jsonl`,
with a `.meta.json` sidecar carrying `agentType`, `toolUseId`, `spawnDepth` and
`parentAgentId`. Measured across 320 sidecars on one machine: depth 1 ×267,
depth 2 ×48, depth 3 ×5, and 53 naming a parent. The `output_file` the provider
already captures is a symlink into exactly that path.

So "show me what this agent actually did" needs no provider change — it needs a
file reader. Two traps are written up in
[extensions.md](../extensions.md#how-provider-transcripts-render): the
directory is keyed by the session id that was current when the agents
**spawned** (Claude rotates that id on resume, so glob by the unique `taskId`
instead), and `outputFile` only arrives at the terminal event, so it cannot
back a live view.

`outputFile`, `toolUseId` and `taskType` are published on the status snapshot
and still unread here. Adding them is the first line of that work, and was left
out of this change rather than landing fields nothing renders.
