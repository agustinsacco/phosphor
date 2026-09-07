# Headroom as a middleman extension

**Status: proposed, nothing implemented.** Research done 2026-09-07 against
Headroom 0.37.0 (`headroom-ai`, Apache-2.0) and pi 0.84.2, with the proxy run
locally and measured on this repo's own tool output.

## Verdict

Attach Headroom at pi's `tool_result` hook as a bundled pidex extension, not
at the HTTP layer. Compress tool **outputs** only, fail open, default off.

The reason is a hard limit, not a preference: on the Claude Code provider —
pidex's usual mode — `Read`, `Write`, `Edit`, `Bash`, `Grep` and `Glob` run
**inside the CLI** and never touch pi's tool layer
(`tool-mapping.ts: isHandoffClaudeTool`, and the same finding is already
recorded in `pi-ext/worktree-paths.ts`). Only custom tools —
`mcp__custom-tools__*`, i.e. every MCP connector — are handed off to pi. So:

| Session kind                    | What the hook can compress |
| ------------------------------- | -------------------------- |
| pi-native (Bedrock, Anthropic…) | every tool result          |
| Claude Code provider            | MCP connector results only |

That is still the right target. MCP results are the JSON-shaped payloads
Headroom compresses best, and they are the ones no CLI-side truncation
touches.

## What Headroom actually is

- A **Python** service. The compression engine is Python + a Rust core; the
  `headroom-ai` npm package is a thin HTTP client over it
  (`compress()` → `POST /v1/compress`, default `http://localhost:8787`).
  There is no pure-TS compressor to bundle.
- Install is heavy: `headroom-ai[proxy]` resolved to a **503 MB** venv,
  `[ml,code]` took it to **1.4 GB** (torch, tree-sitter). Not shippable
  inside the app — the user installs it, pidex detects it.
- The proxy is loopback-only by default with no inbound token, and local
  stats are opt-in. **The upload beacon is opt-OUT** (`BEACON_DEFAULT_ON =
True`; content-free session summaries to Headroom Labs). pidex must set
  `HEADROOM_BEACON=off` and `DO_NOT_TRACK=1` on anything it spawns or talks
  to.

The endpoint pidex would use is stateless:

```
POST /v1/compress  {messages, model, token_budget?, config?}
                → {messages, tokens_before, tokens_after, tokens_saved,
                   compression_ratio, transforms_applied, ccr_hashes}
GET  /health      → {status, ready, checks:{…}}
```

## Measured, on this repo

One tool result per request, wrapped in a three-message envelope, model
`claude-sonnet-4-5`, proxy 0.37.0 with `[proxy,ml,code]`:

| Tool output                           | Before  | After  | Saved | Latency |
| ------------------------------------- | ------- | ------ | ----- | ------- |
| MCP JSON, 120 Linear-shaped records   | 30,203  | 14,075 | 53%   | 67 ms   |
| `grep -rn session src/ electron/`     | 46,796  | 34,158 | 27%   | 42 ms   |
| test log, 4k lines with real failures | 126,978 | 34,049 | 73%   | ~1 s    |
| `git log --stat -n 40`                | 19,318  | 19,318 | 0%    | 5 ms    |
| `read` of a 9.4 KB TypeScript file    | 2,377   | 2,377  | 0%    | 3 ms    |

Code reads and git output are deliberately excluded by Headroom's own router
(`router:excluded:tool`, `router:noop`). The win is JSON and logs.

**JSON compression is high fidelity.** 120 records became a typed header plus
CSV rows — schema first, every record kept, nothing summarised away.

**Log compression is lossy and irreversible.** The 4k-line test log kept the
`FAIL` line, the `AssertionError` and most `ERROR` lines, but dropped three
`ERROR` lines inside a `[2711 lines omitted: 3 ERROR, 2725 INFO]` marker, and
mangled some timestamps mid-line. A _uniform_ 4k-line log collapsed to a
single `[4001 lines omitted: 4000 INFO]` — 127,020 tokens to 32.

And it cannot be undone: every response came back with `ccr_hashes: []` and
`/v1/retrieve/stats` showed an empty store, with CCR requested explicitly.
**Reversible compression does not engage on the stateless endpoint in 0.37.0**,
so the model cannot ask for what was dropped.

That is the whole risk of this feature in one paragraph. It is also why the
design below never compresses a `bash` result by default.

## Design: `pi-ext/headroom.ts`

A sixth bundled extension, loaded like the other five, inert unless enabled.

- **Gate.** Does nothing unless `PIDEX_HEADROOM_URL` is set in pi's env. One
  `GET /health` at first use; a failure disables the extension for the rest of
  the session, permanently and silently.
- **Hook.** `pi.on("tool_result")`, which is documented to chain like
  middleware and may return a partial patch (`content`, `details`, `isError`,
  `usage`). Only text parts of `content` are touched; images pass through.
- **Eligibility**, narrow by construction, same discipline as
  `worktree-paths.ts`:
  - skip `isError: true` — the error text _is_ the payload;
  - skip results under a token floor (~1k tokens; nothing to win);
  - skip `write` / `edit` / `read`;
  - **skip `bash` by default** — that is where the lossy path lives;
  - compress custom/MCP tools, `grep`, `find`, `ls`.
- **Fail open, always.** Timeout (3 s default), `ctx.signal` linked, any
  throw / non-200 / malformed body / result-not-smaller leaves the original
  untouched. A compression service must never be able to fail a turn.
- **Say so.** Cumulative per-session savings pushed on `ctx.ui.setStatus` under
  a `pidex-headroom` key, rendered in the context meter beside the existing
  breakdown. A silently rewritten tool result is exactly the failure
  `worktree-paths.ts` exists to prevent; the meter is how the user sees it
  happened. The key also has to be added to `STRUCTURED_STATUS_KEYS`.

Cost when enabled: one loopback round trip per eligible tool result, measured
3–67 ms typical and ~1 s on a 127k-token payload.

## Rejected

- **`ANTHROPIC_BASE_URL` on the Claude CLI spawn.** This is Headroom's own
  recommended integration and it _would_ cover the CLI-side built-ins the hook
  cannot see. It also routes the user's Claude subscription OAuth token through
  a third-party local process on every request, and rewrites the payload
  underneath a provider whose prefix caching pidex has spent several fixes
  protecting. Not doing this without an explicit decision from the user.
- **`headroom mcp` as a connector.** Gives the model `headroom_compress` /
  `headroom_retrieve` tools. That is compression under the model's control,
  after the tokens have already been spent. Wrong layer for this problem.
- **`headroom-ai` npm in-process.** It is an HTTP client for the same proxy,
  so it buys nothing over `fetch` and adds a dependency to pi's runtime.
- **pi's `context` / `before_provider_request` hooks** (whole-history
  rewriting). On the Claude provider, full history is sent only on create and
  import — 0.7.0 keeps one CLI process and sends the new turn only — so
  history rewriting there is both ineffective and a way to desync pi from the
  CLI's transcript.

## Open decisions (user's call)

1. **Is a lossy `bash` result acceptable at all?** Default above says no. If
   yes, it should be its own opt-in, not folded into the main switch.
2. **The 1.4 GB install.** pidex can detect and use it, but somebody has to
   install it. Is that acceptable, or is this only worth it as a per-user
   power feature?
3. **`ANTHROPIC_BASE_URL` mode** — the only way to reach Claude Code's own
   `Read`/`Bash`/`Grep`. Worth the OAuth and cache exposure, or not?

## Plan

1. `pi-ext/headroom.ts` + `pi-ext/headroom.test.ts` (pure eligibility,
   envelope, response validation and accumulator logic; a fake `fetch`).
   Wired into `bundledExtensions()`, inert with no env var. Docs: the
   `pi-ext/` table in [../extensions.md](../extensions.md), and the two
   "five extensions" counts in [../../README.md](../../README.md).
2. Settings → Agent toggle + `HEADROOM_BEACON=off` / `DO_NOT_TRACK=1` /
   `PIDEX_HEADROOM_URL` on `spawnEnv`, plus a "not installed" state that links
   the install command.
3. The savings row in the context meter.

Step 1 is a self-contained PR. Steps 2 and 3 should not start until the open
decisions above are answered.
