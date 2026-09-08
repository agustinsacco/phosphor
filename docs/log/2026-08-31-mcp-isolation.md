# MCP isolation: one door into a Claude session

**2026-08-31.** A `pi-claude-cli` session was loading MCP servers from two
chains at once. Only one of them is Phosphor's, and the other one was invisible.

## What was wrong

Phosphor writes connectors to `~/.pi/agent/mcp.json`, the adapter loads that chain
and registers `mcp` / `mcpScript` into pi's tool registry, and pi-claude-cli
snapshots pi's non-built-in tools into a schema-only MCP server it hands the
CLI as `--mcp-config`. That part worked: the gateway arrives as
`mcp__custom-tools__mcp` with `Servers: linear, notion, fellow` baked into its
description.

But the CLI also loads its own chain — `~/.claude/.mcp.json`, `~/.claude.json`,
and the user's claude.ai account connectors. Measured in one session's
transcript: 65 extra tool names (Questrade 25, Supabase 30, Snowflake 8+),
~2.6KB of names plus a ~3.7KB instructions block, on every request.

Tokens were the smaller half:

- Only `mcp__custom-tools__*` becomes a pi tool call (`tool-mapping.ts`), so
  those servers never produced `tool_execution_*` events and
  `pi-ext/worktree-paths.ts` could not guard them.
- The `MCP n/m` footer chip and the context meter both read the adapter, which
  knows nothing about that chain. Both silently undercounted.
- The same project behaved differently on two machines.

## The fix, and the trap in it

`--strict-mcp-config` drops the CLI's own chain and keeps only
`--mcp-config`. pi-claude-cli already passed it — but only bundled inside
`PI_CLAUDE_CLI_HERMETIC`, together with an empty `--setting-sources`.

That bundle is unusable here. `--setting-sources ""` drops the CLI's CLAUDE.md
auto-memory, and Phosphor already passes `--no-context-files` so pi omits its own
copy (~4,900 tokens of duplication, see
[2026-08-29-claude-provider-token-overhead.md](2026-08-29-claude-provider-token-overhead.md)).
Enabling hermetic for real sessions would have left the model with project
instructions from **neither** side.

So pi-claude-cli 0.5.1 splits them: `PI_CLAUDE_CLI_STRICT_MCP` passes the MCP
flag alone. Phosphor sets it for every Claude-provider spawn
(`claudeProviderSpawnEnv` in `electron/pi/provider-detect.ts`), reusing the
same provider verdict that already drives `--no-context-files`.

Verified live on claude 2.1.231, on the `-p` path the provider uses: asked
whether any `mcp__claude_ai_*` tool exists, the CLI answers `YES` without the
flag and `NO` with it.

## Two defects found on the way

Both fixed in pi-claude-cli 0.5.1, both outside this repo.

- **The tool surface froze at turn 1.** `mcpConfigResolved` locked after the
  first request, but the adapter re-registers `mcp` with a new description
  whenever a server is added, enabled or disabled. Connecting a connector
  mid-session never reached the model; the session advertised its turn-1
  surface for life. The snapshot now refreshes per turn and only touches disk
  when the tool defs actually changed.
- **The temp files leaked.** Two `$TMPDIR` files per pi process, never removed:
  206 files and 1.7MB on one machine, oldest six days. Now unlinked on exit. A
  SIGKILLed process still leaks, the same residual exposure the system-prompt
  file has (19 of those on the same machine).

## Why the gateway, and what would undo it

`mcp` + `mcpScript` cost ~3.9KB of schema regardless of how many servers are
configured — the only per-server growth is the names in the `mcp` description,
~11 bytes each. The flat alternative, from the adapter's own cache: Linear 67
tools / 79.7KB, Notion 37 tools / 126.7KB.

`directTools` on a server entry opts out, promoting that server's tools to flat
top-level names. The MCP tab exposes the field; nothing currently sets it.

## Follow-up, done separately

Settings had separate **Connectors** and **MCP** tabs showing the same servers,
and only the connector view carried per-server state. They are now one tab —
see [2026-08-31-connectors-mcp-merge.md](2026-08-31-connectors-mcp-merge.md).
That merge was only honest once this change cut the second chain off.
