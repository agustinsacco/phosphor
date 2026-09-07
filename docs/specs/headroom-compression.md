# Headroom as a middleman extension

**Status: proposed, nothing implemented.** Research done 2026-09-07 against
Headroom 0.37.0 (`headroom-ai`, Apache-2.0, repo at `e67b3c8`) and pi 0.84.2.
The proxy was run locally and measured on this repo's own tool output, and
Headroom's own harness plugins were read as the reference integrations.

## Verdict

Attach at pi's `tool_result` hook as a bundled pidex extension. Compress tool
**outputs** at the moment they are produced, fail open, default off.

This deviates from Headroom's own harness plugins, which compress the whole
message list before every request (`plugins/opencode`, `plugins/openclaw` —
`HeadroomContextEngine.assemble()`). The deviation is deliberate; see
[Why not whole-history](#why-not-whole-history).

## Coverage, and the hard limit

On the Claude Code provider — pidex's usual mode — `Read`, `Write`, `Edit`,
`Bash`, `Grep` and `Glob` run **inside the CLI** and never touch pi's tool
layer (`tool-mapping.ts: isHandoffClaudeTool`; the same fact is already
recorded in `pi-ext/worktree-paths.ts`). Only custom tools —
`mcp__custom-tools__*`, i.e. every MCP connector — are handed off to pi.

| Session kind                    | What the hook can compress |
| ------------------------------- | -------------------------- |
| pi-native (Bedrock, Anthropic…) | every tool result          |
| Claude Code provider            | MCP connector results only |

Headroom has no hook-based answer for this. Its Claude Code plugin
(`plugins/headroom-agent-hooks`) is two `SessionStart` / `PreToolUse` hooks
that run `headroom init hook ensure` — they start the proxy and nothing else.
Every documented Claude Code path is the HTTP proxy.

## What Headroom actually is

- A **Python** service with a Rust core. The `headroom-ai` npm package is a
  thin HTTP client over it (`compress()` → `POST /v1/compress`, default
  `http://localhost:8787`). There is no pure-TS compressor to bundle.
- Install is heavy: `headroom-ai[proxy]` resolved to a **503 MB** venv,
  `[ml,code]` took it to **1.4 GB** (torch, tree-sitter).
- Loopback-only by default, no inbound token, local stats opt-in. **The upload
  beacon is opt-OUT** (`BEACON_DEFAULT_ON = True`; content-free session
  summaries to Headroom Labs). pidex must set `HEADROOM_BEACON=off` and
  `DO_NOT_TRACK=1`.

```
POST /v1/compress  {messages, model, token_budget?, config?}
                → {messages, tokens_before, tokens_after, tokens_saved,
                   compression_ratio, transforms_applied, ccr_hashes}
GET  /v1/retrieve/<hash>
GET  /health
```

## Measured, on this repo

One tool result per request, three-message envelope, model
`claude-sonnet-4-5`, proxy 0.37.0 with `[proxy,ml,code]`:

| Tool output                           | Before  | After   | Saved | Latency |
| ------------------------------------- | ------- | ------- | ----- | ------- |
| MCP JSON, 120 Linear-shaped records   | 30,203  | 14,075  | 53%   | 67 ms   |
| MCP JSON, 2,000 records               | 218,720 | 142,747 | 35%   | ~1 s    |
| `grep -rn session src/ electron/`     | 46,796  | 34,158  | 27%   | 42 ms   |
| test log, 4k lines with real failures | 126,978 | 34,049  | 73%   | ~1 s    |
| `git log --stat -n 40`                | 19,318  | 19,318  | 0%    | 5 ms    |
| `read` of a 9.4 KB TypeScript file    | 2,377   | 2,377   | 0%    | 3 ms    |

The two zeroes are by design, not failure. `wiki/LIMITATIONS.md` documents code
as passthrough behind `protect_recent_code=4` and `protect_analysis_context`,
on the grounds that code is fetched because the user wants to work with it.

## Two transforms, and only one of them is safe

Everything above ran one of two very different transforms, and the design
turns on the difference.

**Restructuring — safe.** JSON tool results hit `router:tool_result:mixed`,
which rewrites the array as a typed schema header plus CSV rows. Verified by
counting identifiers in the output: **120 of 120 records survived**, and 500
and 2,000-record arrays behaved the same. Nothing is summarised away, so
nothing needs retrieving.

**Dropping — not safe.** Logs and search output hit
`router:tool_result:search`, which deletes lines. A 4k-line log with seeded
failures kept the `FAIL` line, the `AssertionError` and most `ERROR` lines,
but swallowed three `ERROR` lines inside a `[2711 lines omitted: 3 ERROR,
2725 INFO]` marker and mangled some timestamps. A _uniform_ 4k-line log
collapsed to a single `[4001 lines omitted: 4000 INFO]` — 127,020 tokens to 32.

**And on this path the dropping is irreversible.** Every response came back
`ccr_hashes: []` with no `hash=` marker, at 120, 500 and 2,000 records and on
both log runs, and `/v1/retrieve/stats` stayed empty. This is not a bug to
wait out. `wiki/ccr.md` says it plainly: "the full compress-cache-retrieve
tool-call loop (`headroom_retrieve`, proactive expansion) only runs inside
`headroom proxy`, not the standalone SDK call." CCR needs to own the
request/response loop to intercept the model's retrieve call. A `tool_result`
middleman never has that. (The FAQ in `wiki/integration-guide.md` claims CCR
covers the SDK path too; `wiki/ccr.md` is the accurate one.)

So the extension must not trust `transforms_applied` after the fact — it must
**verify the output**: if the compressed text contains an omission marker and
no retrievable hash, discard the compression and keep the original. That rule
is enforceable from the response alone and does not depend on Headroom's
config staying the same.

## Design: `pi-ext/headroom.ts`

A sixth bundled extension, loaded like the other five, inert unless enabled.

- **Gate.** Nothing happens unless `PIDEX_HEADROOM_URL` is set in pi's env.
  One `GET /health` at first use; failure disables the extension for the rest
  of the session.
- **Hook.** `pi.on("tool_result")` — documented to chain like middleware and to
  accept a partial patch of `{content, details, isError, usage}`. Only text
  parts are touched; images pass through.
- **Eligibility**, narrow by construction, same discipline as
  `worktree-paths.ts`: skip `isError` (the error text _is_ the payload), skip
  under ~1k tokens, skip `read`/`write`/`edit`, skip `bash` by default. Compress
  custom/MCP tools, `grep`, `find`, `ls`.
- **Accept-or-discard.** Keep the compressed text only if it is smaller _and_
  carries no unretrievable omission marker. Otherwise keep the original.
- **Fail open, twice.** A 3 s timeout per call linked to `ctx.signal`, plus a
  circuit breaker — N consecutive failures open it for a cooldown, as
  `HeadroomContextEngine` does. Any throw, non-200, or malformed body leaves
  the result untouched. A compression service must never fail a turn.
- **Say so.** Cumulative per-session savings on `ctx.ui.setStatus` under a
  `pidex-headroom` key, rendered in the context meter. A silently rewritten
  tool result is exactly the failure `worktree-paths.ts` exists to prevent.
  The key also needs adding to `STRUCTURED_STATUS_KEYS`.
- **No `headroom_retrieve` tool.** Headroom's own plugins register one. On this
  path it could never succeed — there are no hashes to retrieve by — so
  shipping it would be a tool that always errors.

Cost when enabled: one loopback round trip per eligible tool result, 3–67 ms
typical, ~1 s on a 200k-token payload. That is far inside `HANDOFF_WAIT_MS`
(30 min), the ceiling on a blocked Claude CLI handoff.

## Why not whole-history

pi's `context` event is a 1:1 match for OpenClaw's `assemble()` — a deep copy
of the message list, returned modified. It is the vendor's own pattern, and it
is still wrong here, for two reasons.

**It busts the prefix cache.** `wiki/proxy.md` is explicit: a stateless caller
must pass `config.frozen_message_count` _and_ resend the messages it previously
forwarded rather than the pristine originals, or it "silently destroys the
provider's prefix cache." `HeadroomContextEngine.assemble()` passes neither.
pidex has spent several fixes protecting that cache; re-earning that bug is not
worth 35%.

**It does nothing on Claude sessions.** pi-claude-cli 0.7.0 keeps one CLI
process and sends full history only on create and import. Rewriting history
mid-session would be both ineffective and a way to desync pi from the CLI's
transcript.

The `tool_result` design sidesteps `frozen_message_count` entirely: a compressed
result is written once and never rewritten, so the bytes of every earlier
message are stable by construction.

## The three ways to reach Claude Code's own tools

None is in scope. Recording them so the option space is not re-derived.

1. **`ANTHROPIC_BASE_URL` on the CLI spawn** — Headroom's documented path, and
   it enables CCR because the proxy owns the loop. It also routes the user's
   Claude subscription OAuth through a third-party local process on every
   request.
2. **Transport interception** — what `plugins/opencode/src/transport.ts` does:
   monkeypatch `fetch`, `http`, `https`, `http2` _and_ `child_process.spawn/
exec/execFile/fork`, injecting `NODE_OPTIONS=--import=<shim>` so children
   are patched too. That would reach the CLI. `shouldRoute()` sends **every**
   non-loopback request through the proxy, not just LLM calls, and pi's process
   is one pidex spawns and depends on. Too wide.
3. **Do nothing there** — accept that Claude sessions get MCP compression only.
   The default.

## Open decisions (user's call)

1. **Lossy `bash` results** — the default above says never. If ever, it should
   be its own opt-in switch, not folded into the main one.
2. **The 1.4 GB install.** pidex can detect and use it; somebody still has to
   install it. General feature, or per-user power feature?
3. **Option 1 or 2 above** — the only ways to reach Claude Code's built-ins.
   Worth the exposure, or not?

## Plan

1. `pi-ext/headroom.ts` + `pi-ext/headroom.test.ts` (eligibility, envelope,
   accept-or-discard, circuit breaker, accumulator — pure logic, fake `fetch`).
   Wired into `bundledExtensions()`, inert with no env var. Docs: the `pi-ext/`
   table in [../extensions.md](../extensions.md) and the two "five extensions"
   counts in [../../README.md](../../README.md).
2. Settings → Agent toggle, proxy lifecycle owned by the main process (health
   check, `HEADROOM_BEACON=off`, `DO_NOT_TRACK=1`, `PIDEX_HEADROOM_URL` on
   `spawnEnv`), and a "not installed" state that shows the install command.
3. The savings row in the context meter.

Step 1 is a self-contained PR. Steps 2 and 3 wait on the open decisions.
