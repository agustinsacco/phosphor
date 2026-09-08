# 2026-09-07 — the context popover stops running off the screen

The context meter's popover had grown one section at a time — context
composition, MCP servers, tokens, session, plan usage, plan limits — each one a
single narrow column, stacked. On a real Claude session with four connectors and
three usage windows it measured about 1500px tall in a 900px window, and it
anchors _upward_ from the composer, so the overflow clipped its own "Session
usage" heading off the top. Nothing was wrong with the numbers; the panel just
had no layout.

## What changed

**Wider, in rows.** 27rem instead of 20rem, and the three list-shaped sections
now use the width: the composition legend is a two-column grid, Tokens and
Session sit side by side, and the plan windows are a three-up row. The window
total moved into the heading, which removed the "Window" row entirely. Same
data, ~500px tall, measured 432×509 at 1280×860 and inside the viewport at
780×520 as well. The body scrolls (`max-h`, `overflow-y-auto`) as a backstop
rather than as the plan — the panel is meant to fit.

**Plan usage as dials.** One 42px arc per window with the percent inside it, a
short window name, and a compact countdown ("5d 16h", "4h 18m") under it. Three
labelled bars needed three rows for the same three numbers, and the arc reads
without being read. Thresholds are unchanged and still shared with every other
meter in Phosphor (`usageBarClass`, and now `usageStroke` for the SVG).

**MCP servers as chips.** Name plus tokens, wrapped, instead of a row each. A
row spent a full line of height on twenty-five characters. The tooltip is where
the honest answer about MCP cost now lives: under the gateway only one proxy
tool per server (`mcp__<server>`, ~700 tokens) is in the window, and each
server's own tools are fetched on demand — unless the server opts into
`directTools`, which promotes them all.

**Refresh.** `claude:usageSnapshot` takes a `force` flag, and the popover's new
Refresh control is the only caller allowed to pass it. Main's 60s cache is what
keeps many surfaces from hammering an endpoint that rate-limits, but a refresh
button that returns the cached answer looks broken. Concurrent forces still
share one CLI run, so a double click is one spawn.

**Switch account, unconditionally.** Moving a lane to another Claude login was
previously offered only while the current account was held back, and only to the
one account routing would have picked next. It is now offered whenever a second
signed-in account exists, and lists all of them — held ones included and marked,
because a hold comes from a cached `/usage` reading and the person watching a
stuck lane knows more than the cache does. The mechanism is the one that already
existed (`moveSessionToAccount`: bind, dispose, resume the same session file), so
this is still a respawn with a full re-read of the thread, and the panel says so
where the click is. The target list is fetched when the picker opens, never on
popover open — `claude:accounts` runs `claude auth status` once per account.

## Merging with Headroom

Headroom's phase 1 ([#221](https://github.com/agustinsacco/Phosphor/pull/221))
landed its own `Optimization · Headroom` section in this same file while the
redesign was in flight, as a fragment of three labelled rows after "Tool
calls". "Tool calls" is now the last row of a 190px column, where
`48k → 36k · 120 ms last` wraps twice. The section is a full-width row below
the grid instead, with the saving promoted into its own header
(`−12.4k`, in success colour) and the before/after, result count and last
duration on one line under it. Same numbers, same honesty about the lossy
skip, three lines instead of eight. Two tests pin the placement, because a
future conflict in this region would otherwise drop the section silently.

## Notes

- `windowShortTitle`, `compactReset` and `usageStroke` are in
  `src/lib/claudeUsage.ts` with the other shared usage presentation, so the
  popover and Settings → Claude Code cannot disagree about what a window is
  called or where a threshold is.
- The browser harness's mock breakdown gained `mcpByServer`, so the MCP chips
  and the dials are both visible in `npm run dev:web` — that is how this
  redesign was checked at three window sizes without a real session.
