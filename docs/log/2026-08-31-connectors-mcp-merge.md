# Connectors and MCP were one list wearing two tabs

**2026-08-31.** Settings had a **Connectors** tab and an **MCP** tab. They were
not two features. They were two views of the same list, and the split cost
correctness, not just clicks.

## Why it was one thing

Connecting Notion from the Connectors tab wrote `~/.pi/agent/mcp.json` — which
is the `pi-global` scope of the exact chain the MCP tab resolved and rendered.
So the same three servers appeared in both tabs, with different controls on
each.

The split was not symmetric:

|                                          | Connectors | MCP    |
| ---------------------------------------- | ---------- | ------ |
| server set                               | curated 6  | any    |
| OAuth flow                               | yes        | no     |
| structured per-server state              | **yes**    | **no** |
| scope badge, shadowing                   | no         | yes    |
| enable toggle, `directTools`, raw editor | no         | yes    |
| adapter install                          | no         | yes    |

Row three is the defect. `McpTab.tsx` consumed the adapter's status only as
raw footer text (`stripAnsi`); the structured state in
`src/features/connectors/mcpStatus.ts` was wired into `ConnectorsTab` alone.
The tab that listed _every_ server was the one that could not tell you whether
any of them worked.

## What it is now

One tab, `ConnectorsTab.tsx`. The list is the resolved chain — the truth —
enriched with catalog metadata wherever a server URL matches a known connector.

1. **Connected** — scope badge, status chip, transport, Sign in / Reconnect,
   enable toggle, Edit, Remove, cached tools, shadows. First on the page.
2. **Add a connector** — the catalog, minus anything already configured.
3. **Advanced** (collapsed) — adapter install state, chain file list, raw JSON
   editor. Repair tools, not daily controls.

Sign in is offered only for `url` servers: a stdio `command` server has no
OAuth flow to run, and the old Connectors tab could never express that because
it only ever rendered catalog entries.

New in the merge: a row whose config sets `directTools` now says so in warning
colour. That field promotes a server's tools to flat top-level names, opting it
out of the `mcp` gateway — worth ~80KB of schema for a server like Linear,
against ~3.9KB for the gateway serving all of them. It was previously rendered
as a neutral fact.

## Ordering is load-bearing

**Connected** renders before the catalog. Beyond being the right emphasis, the
e2e test drives `getByRole('checkbox').first()` to toggle a seeded server, and
Linear's catalog row carries a `read-only` checkbox. Catalog-first would hand
that assertion the wrong control.

## Honesty precondition

This merge was deliberately not done earlier. Until
[2026-08-31-mcp-isolation.md](2026-08-31-mcp-isolation.md) cut off the Claude
CLI's own MCP chain, a single tab claiming to be the complete inventory of what
a session can reach would have been wrong: Snowflake and the claude.ai
connectors were reachable by the model and invisible to every Phosphor surface.

## Verification

`typecheck / lint / format / unit` green. All 34 e2e pass, including the three
connector specs — one renamed to match, two unchanged, which is the useful
signal: the merged tab satisfies assertions written against both old tabs.
