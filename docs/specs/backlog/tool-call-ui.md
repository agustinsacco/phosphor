# Tool-call and MCP row UI

Audit of how a tool call renders in the transcript, on both the pi-native and
the `pi-claude-cli` provider. Measured against one real session
(`01a0548d-9f3a-7f50-aa3f-d8e0d70071a9`, Claude provider, 163 unique bash
calls).

**Headline, as written 2026-09-01.** The row label is 64 characters and it is
spent on setup. 96% of the session's bash calls are multi-line scripts and 94%
open with `cd`, `echo` or a variable assignment, so the command that the row
actually ran is past the truncation point. MCP is worse: every gateway call
renders as `Used mcp` regardless of which of its nine modes ran.

**Half of that headline is now obsolete.** The bash-truncation complaint (F1,
F2) was fixed by `commandHeadline()`, which splits a script and labels the row
by its operative line. The MCP half is exactly as true as the day it was
written: F3, F5 and F6 are one untouched lane — nothing anywhere in
`src/features/chat/` reads an MCP gateway call's mode.

Status column is re-verified against the code, never inferred from this file.

| #   | Finding                                                | Status as of 2026-09-09           |
| --- | ------------------------------------------------------ | --------------------------------- |
| F1  | Multi-line scripts collapse to their setup line        | **fixed** — `31426e6`             |
| F2  | `cd <ws>` strip only matches `&&`, not newline         | **fixed** — `31426e6`             |
| F3  | Every MCP gateway call renders as `Used mcp`           | open                              |
| F4  | A failed tool hides its arguments two clicks deep      | open                              |
| F5  | Raw `mcp__server__tool` names leak into the label      | open — **pinned by a test**       |
| F6  | `ToolSearch` rows show the machine query               | open                              |
| F7  | Structured MCP chip degrades silently to prose         | open                              |
| F8  | `mcp({})` fails on every Claude session (not Phosphor) | **fixed** — `pi-claude-cli` 0.7.1 |

Two notes on the resolved rows. F1/F2 landed together in `31426e6` ("Label bash
rows by their operative line"), with the split behaviour locked by
`toolSummaries.test.ts`; F2 stopped being separately fixable because the `cd`
strip now runs after the split, so the separator no longer matters. F8 was
never Phosphor's to fix and was fixed upstream — `event-bridge.ts` in
`pi-claude-cli` 0.7.1 special-cases an empty `partialJson` on a `tool_use`
block end, which is the `mcp({})` / `artifact_list()` case. A non-empty but
unparseable payload still passes through raw, deliberately.

**Before picking up F5, read its test.**
`src/features/chat/items/claudeCliRendering.test.ts` asserts the raw
`mcp__linear__save_issue` string reaches the label, so the current behaviour is
pinned. Changing it means changing that assertion — decide the intent first
rather than treating the test as an accident.

## F1 — Multi-line scripts collapse to their setup line

`cleanCommandForDisplay` (`src/features/chat/tools/toolSummaries.ts`) flattens
whitespace, so every line of a script joins into one string, and
`truncate(display, 64)` then keeps only the head of it.

Reproduced byte-for-byte from the session:

```
Ran cd ~/.pi/agent/npm/node_modules/pi-mcp-adapter echo "=== adapte…
```

The `grep` this row ran is invisible. Same code path serves both providers, so
`summarizeTool` and `summarizeExternalTool` are equally affected.

**Proposed.** Label the _operative_ line. Split on newline / `&&` / `;`, drop
`cd`, `export`, `set`, `VAR=`, `echo` and `#`, take the first survivor, and
suffix `+N more` when other real commands follow. Replaying the rule over all
163 commands changes 95% of labels, every one of them toward the actual verb:

```
TODAY     Ran cd ~/.pi/agent/npm/node_modules/pi-mcp-adapter echo "=== adapte…
PROPOSED  Ran grep -n "mcp.json\|\.mcp\.json\|scope\|XDG" config.ts   +9 more

TODAY     Ran echo "=== global mcpServers in ~/.claude.json ===" jq -r '.mcpS…
PROPOSED  Ran jq -r '.mcpServers // {} | keys[]' ~/.claude.json
```

**Trade-off.** Picking an operative line is a heuristic, and a script whose
intent genuinely is its `echo` gets a worse label. The expanded detail keeps
the full command and `+N more` stops the row claiming to be the whole script,
so the failure mode is a vaguer label, never a wrong one.

## F2 — The `cd <ws>` strip only matches `&&`

The prefix regex requires `&&`. Models write `cd <ws>` followed by a newline,
which never matches, so the workspace path only degrades to its basename and
still spends ~30 of the 64 characters. Accept `&&`, `;` and newline.

## F3 — Every MCP gateway call renders as `Used mcp`

Both summarizers drop MCP to `default:`, which emits the tool name and nothing
else. The gateway's mode lives entirely in its arguments and the arguments are
not on the row, so a status check and a write render identically:

| Call                                | Renders as | Actually does             |
| ----------------------------------- | ---------- | ------------------------- |
| `mcp({})`                           | `Used mcp` | server status             |
| `mcp({server:"linear"})`            | `Used mcp` | lists 67 tools            |
| `mcp({connect:"linear"})`           | `Used mcp` | performs an OAuth connect |
| `mcp({tool:"linear_save_issue",…})` | `Used mcp` | writes to Linear          |

**Proposed.** Read the mode off the args — `MCP status`, `Listed linear tools`,
`Searched MCP tools for issue`, `Connected linear`, `linear · list teams` — and
carry the server name as a gutter chip, reusing the `cc` mark pattern already
in `ActivityGroup`.

## F4 — A failed tool hides its arguments two clicks deep

`GenericDetail` puts arguments behind a nested toggle. For the F8 failure the
argument (`""`) _was_ the whole diagnosis. Default `argsExpanded` to `true`
when `tool.isError`.

## F5 — Raw `mcp__server__tool` names leak

`Used mcp__linear__save_issue`. The string is already delimited; split it into
a server chip plus a humanised operation.

## F6 — `ToolSearch` rows show the machine query

`Searched tools for select:mcp__custom-tools__mcp,mcp__custom-tools…` — a
protocol string truncated mid-identifier. Strip the `select:` prefix and the
`mcp__custom-tools__` namespace, then list the tool names.

## F7 — The structured MCP chip degrades silently to prose

`src/features/connectors/mcpStatus.ts` parses six real per-server states and
`McpChip` renders them well. When the snapshot is absent the adapter's own
sentence (`MCP: 4 servers enabled`) falls through the generic status strip
instead, so the footer can show prose that disagrees with the chip. Suppress
the prose whenever `parseMcpStatus` returns a snapshot.

Related cosmetic issue in the adapter's own output:
`linear (67 tools (not connected, cached))` — doubled parentheses, and two
states that read as contradictory.

## F8 — `mcp({})` fails on every Claude-provider session

Not a Phosphor bug; recorded here because it is what a user hits first when
debugging MCP from a Phosphor session.

```
mcp({})  →  Validation failed for tool "mcp":
              - root: must be object
            Received arguments:
            ""
```

**Root cause.** `pi-claude-cli` 0.5.1, `src/event-bridge.ts` (the `tool_use`
branch of the block-end handler). A tool call with no arguments emits zero
`input_json_delta` events, so the accumulator stays `""`. `JSON.parse("")`
throws, the catch hands pi the raw empty string, and pi rejects it against the
schema.

**Fix.** `JSON.parse(block.partialJson || "{}")`.

**Blast radius.** Every zero-argument handoff tool on every Claude session —
`mcp({})` and `artifact_list()`. Needs a publish and a reinstall to go live;
see the version-floor note in [CLAUDE.md](../../../CLAUDE.md).

## MCP functional verification, 2026-09-01

Every gateway path exercised live against the four configured servers.

| Path                       | Result                                        |
| -------------------------- | --------------------------------------------- |
| `mcp({})`                  | fails — F8                                    |
| `mcp({server})`            | ok — linear 67, fellow 20, notion, braintrust |
| `mcp({search})`            | ok — 17 matches for `issue`                   |
| `mcp({describe})`          | ok — returns parameter shape                  |
| `mcp({tool, args})`        | ok — live `linear_list_teams`                 |
| `mcp({connect})`           | ok — reports OAuth needed for braintrust      |
| `mcpScript` `tools.search` | ok — cross-server, 22 hits for `page`         |
| `mcpScript` `tools.call`   | ok — chained calls, `emit()` output           |
| linear / notion / fellow   | ok — live calls returned real data            |
| braintrust                 | configured, needs OAuth — correct state       |

Aside from F8, MCP works on all four servers. One DX note:
`tools.search({query: ""})` returns 0 rather than listing the server, so an
empty query matches nothing instead of everything.

## Sequencing

F1+F2, then F3+F5+F6, then F4+F7 — three independent lanes, all against
`toolSummaries.ts` and covered by `toolSummaries.test.ts`. F8 is a separate
repo and a separate publish.
