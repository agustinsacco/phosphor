# Headroom as pidex's context middleman

**Status: proposal, nothing built.** Research is verified against sources (links
and line numbers below); the behavioural claims about _pidex + Headroom
together_ are **not** verified — Headroom is not installed on the machine this
was written on, so the spike in [Spike first](#spike-first) has not run. Treat
every "this will work" row below as a hypothesis with a named test.

Ask: can pidex put [Headroom](https://github.com/headroomlabs-ai/headroom) —
a local context-compression proxy — between its sessions and the model, as a
middleman extension?

**Yes, and the interesting part is that it needs two different injection
points, because pidex has two different ways to reach a model.** Headroom is
worth a spike, not a build: the compression numbers are real but the failure
modes (prefix cache, an injected retrieval tool the harness does not own) are
exactly the kind that cost this repo weeks elsewhere.

## What Headroom is

An Apache-2.0 local proxy that rewrites an outgoing request's `messages` before
forwarding it to the provider, and leaves the response alone.

| Fact                                             | Value                                                                     | Source                          |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------- |
| Runs locally, no content leaves to be compressed | yes                                                                       | README "What it does"           |
| Install                                          | `uv tool install "headroom-ai[all]"` — **PyPI only**; Python ≥ 3.10       | `pyproject.toml:11`             |
| npm `headroom-ai`                                | **SDK only, no `headroom` command, no proxy**                             | README "Get started"            |
| Bind                                             | `127.0.0.1:8787` by default; `HEADROOM_PROXY_TOKEN` gates `/v1/*`         | `proxy/server.py:3563`          |
| Anthropic route                                  | `POST /v1/messages`, plus a catch-all passthrough for unmatched paths     | `providers/proxy_routes.py:262` |
| Per-request upstream override                    | `x-headroom-base-url` header                                              | `proxy_routes.py:268`           |
| Modes                                            | `token` (rewrite history for max savings) / `cache` (freeze prior turns)  | proxy docs                      |
| Compression cost                                 | 0.21 ms p50 @ 10K tokens, 1.4 ms @ 100K                                   | README "Proof"                  |
| Claimed savings                                  | 21–57% on tool-output-heavy scenarios; "15–20% average" for coding agents | README                          |

Compression is ML-backed (Kompress, a ModernBERT encoder) with a structural
fallback: `HEADROOM_DISABLE_KOMPRESS=1` drops the model download and keeps
AST/JSON compression. It also ships a compress-only endpoint
(`POST /v1/compress`, loopback-only, no provider key, ignores `system` and
`tools`) and a reversible store (CCR) that caches originals locally and hands
the model a `headroom_retrieve` tool to ask for the full text back.

## The crux: pidex reaches the model two ways

This is the whole design problem, and it is why "just set the base URL" is not
one change.

| Session type                                      | Who speaks to the provider           | Where Headroom goes                   | Can a pi extension do it?                                 |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------- | --------------------------------------------------------- |
| pi-native provider (anthropic, openai, bedrock…)  | pi's own provider stack, in-process  | provider `baseUrl` override           | **Yes** — `pi.registerProvider('anthropic', { baseUrl })` |
| Claude Code provider (`@saccolabs/pi-claude-cli`) | the `claude` CLI, a separate process | `ANTHROPIC_BASE_URL` in the spawn env | **No** — pi's hooks never see the request                 |

Evidence:

- pi documents exactly this use for extensions — _"Proxies — Route requests
  through corporate proxies or API gateways"_ — with
  `pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" })`
  preserving all existing models when only `baseUrl`/`headers` are given
  (`pi/docs/custom-provider.md`).
- pi-claude-cli spawns the CLI with `const env = { ...process.env }` and
  `spawn("claude", args, { env })` (`src/process-manager.ts:192-197`). It owns
  the model call; pi's `context` (`extensions.md:675`),
  `before_provider_headers` (`:687`) and `before_provider_request` (`:705`)
  hooks fire in pi's provider path, which a Claude session does not take.
- pidex already exploits that env passthrough for `PI_CLAUDE_CLI_STRICT_MCP`
  (`electron/pi/provider-detect.ts:50`) and `PI_CLAUDE_CLI_AUTOCOMPACT`
  (`electron/ipc/pi-session-handlers.ts:102`), and pi-claude-cli already
  forwards `ANTHROPIC_BASE_URL` to the CLI by inheritance.
- Headroom's own `headroom wrap claude` does the same thing through
  `_HEADROOM_ENV_KEYS = ("ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH")`
  (`headroom/cli/wrap.py:1031`).

**Consequence:** an extension alone covers only the pi-native half. A
Claude-provider session — the majority of what pidex runs — is reachable only
from the main process, at spawn. So the middleman is deliberately _two_
surfaces with one switch: `pi-ext/context-proxy.ts` **and** one entry in
`spawnEnv`.

Do **not** reuse `headroom wrap claude`: it writes `ANTHROPIC_BASE_URL` into
`~/.claude/settings.json`, which silently reroutes the user's _terminal_
`claude` too, and persists past pidex (upstream tracks that as a self-heal
problem, `wrap.py:1029-1107`). pidex sets env per spawn and mutates nothing.

## Design

Four pieces, one pref (`contextProxy`, off by default). Named `contextProxy`
in code — **"headroom" is already taken** in this UI for the response-token
reserve (`src/features/settings/tabs/AgentTab.tsx:215`, "Reserve tokens —
Headroom kept free for the model's response"). Two different things called
headroom in one product is how the next person debugs the wrong one.

1. **Supervisor** — `electron/context-proxy/`. One proxy process for the whole
   app (not per session): spawn the `headroom` CLI on a loopback port, probe
   `/livez` the way `checkPiHealth()` probes pi, kill on quit. Pass
   `HEADROOM_PROXY_TOKEN` so the data plane is authenticated; Headroom itself
   warns loudly when it is unset on a non-loopback bind (`server.py:3577`), and
   even on loopback the proxy can spend the user's credential.
2. **pi-native route** — `pi-ext/context-proxy.ts`, added to
   `bundledExtensions()` (`pi-session-handlers.ts:53`). Reads port + token from
   env, calls `pi.registerProvider('anthropic' | 'openai', { baseUrl, headers })`
   in an async factory, and registers `headroom_retrieve` via
   `pi.registerTool()` so the tool Headroom injects has a real implementation
   (see sharp edge 1).
3. **Claude route** — a `claudeProxySpawnEnv()` beside `claudeProviderSpawnEnv()`
   in `electron/pi/provider-detect.ts`, returning `ANTHROPIC_BASE_URL` plus
   `ENABLE_TOOL_SEARCH` (sharp edge 3), merged into `spawnEnv` only when the
   session is a Claude session and the pref is on.
4. **Surface** — read `/stats` and show tokens saved next to the context meter,
   on the existing `ctx.ui.setStatus` channel that `pi-ext/context-breakdown.ts`
   already uses (`STATUS_KEY = 'pidex-context-breakdown'`). Proxy-reported
   savings must be a **separate, labelled** line: pi's total is authoritative
   for what pi counted, and the two numbers must never be summed (that rule is
   `docs/extensions.md` "the status channel is a wire contract").

## Sharp edges

1. **CCR injects a tool the harness does not own.** With CCR on, Headroom adds
   `headroom_retrieve` to the request so the model can ask for an uncompressed
   original. pi and the CLI will reject an unknown tool name, and a model that
   cannot retrieve is silently stuck with lossy context. Mitigating evidence:
   Headroom matches retrieval tools through MCP aliases — it explicitly accepts
   `mcp__Headroom__headroom_retrieve` (`headroom/config.py:405-422`) — and
   pidex's `PI_CLAUDE_CLI_STRICT_MCP=1` means a pi-registered tool _does_ reach
   the CLI as an `mcp__…` tool. Fallback: `--no-ccr` (lossy, no recovery path)
   or `mode=lossy_inline`. **The single highest-value thing to test.**
2. **`--mode token` can make it more expensive, not less.** It rewrites prior
   turns, which busts the provider prefix cache this repo's entire cost model
   depends on (see `docs/log/2026-09-02-persistent-claude-cli.md`, where a
   cache-invalidation bug re-billed whole conversations as cache writes).
   Default to `--mode cache`; only claim savings measured against
   `cacheRead`/`cacheWrite` counters, not against raw input tokens.
3. **Claude Code's tool deferral breaks behind a proxy.** Upstream carries
   `ENABLE_TOOL_SEARCH` in the same tuple as the base URL specifically to keep
   deferral on behind the proxy (issue #746, `wrap.py:305-425`). Setting only
   `ANTHROPIC_BASE_URL` is the half-fix.
4. **Not every route is a model call.** The CLI also hits non-`/v1/messages`
   paths (`/v1/messages/count_tokens`, telemetry). Headroom has a catch-all
   passthrough and a `--compress-passthrough` flag for custom paths, so this is
   probably fine — verify by reading `/stats`, not by assuming.
5. **The context meter now describes two different numbers.** pi computes
   occupancy and compaction thresholds on uncompressed tokens; the provider
   sees fewer. Auto-compact may fire late, and the meter's percentage will not
   match the proxy's. Either label it or gate the pref to non-Claude providers
   until it is understood.
6. **Distribution is a Python problem.** The proxy ships only in the PyPI
   package (Python ≥ 3.10, `hnswlib` compiles from source, optional HF model).
   pidex must not bundle that. Detect `headroom` on `PATH` the way the app
   already detects `pi`, offer setup, and stay disabled without it.
7. **Credential reach.** Routing pi's or the CLI's auth through the proxy means
   a token-protected loopback port is holding the user's Anthropic credential.
   Keep the bind on loopback, always set the token, never expose the port on a
   routable interface, and do not add a `connect-src`-style widening of
   anything to make the UI nicer.

## Open questions

A row is only closed when it says so.

| #   | Question                                                                                      | How it gets answered                                | Status   |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- |
| 1   | Does a `headroom_retrieve` call survive pi and the Claude CLI?                                | spike, CCR on                                       | **open** |
| 2   | Net cost after caching in `cache` mode on a real pidex session?                               | spike, `/stats` + provider `cacheRead`/`cacheWrite` | **open** |
| 3   | Real savings on pidex traffic (repo claims 15–20% for coding agents)?                         | spike, `headroom savings`                           | **open** |
| 4   | Does pi's `registerProvider` baseUrl override survive `/model` switching and session restore? | spike on a pi-native model                          | **open** |
| 5   | Is `HEADROOM_DISABLE_KOMPRESS=1` good enough to skip the model download?                      | spike, compare savings                              | **open** |
| 6   | Should `mcp.json` Headroom MCP tools (`headroom_compress`) be the cheaper first ship?         | compare against pref-off default                    | **open** |

## Spike first

No product code until the spike answers 1–3. Headroom is not installed here, so
this is the human's call before anything is installed machine-wide:

```bash
uv tool install "headroom-ai[all]"     # or: HEADROOM_DISABLE_KOMPRESS=1 for structural-only
headroom proxy --mode cache --port 8787   # + HEADROOM_PROXY_TOKEN set
headroom doctor && headroom perf
# pi-native proof (extension calls registerProvider('anthropic', {baseUrl})):
# Claude proof, one session, nothing persisted:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pi -p "read package.json and summarise"
curl -s localhost:8787/stats | jq '.savings_history, .prefix_cache'
```

Then land in three PRs: supervisor + pref (proxy inert, health surfaced) → the
two routes → the meter line. Each is revertible by turning the pref off.

## Alternatives considered

- **`headroom wrap claude`** — loses: mutates `~/.claude/settings.json`, so it
  reroutes the user's terminal `claude` and outlives pidex.
- **Headroom as an MCP server in `mcp.json`** — cheapest wiring (Connectors
  already does this job) but the model has to opt in per call, it never
  compresses the conversation itself, and it still needs Python. Kept as open
  question 6, not dismissed.
- **A pure-JS compressor inside a pi extension** (`context` event, or the
  `POST /v1/compress` endpoint from the extension) — no sidecar, no credential
  forwarding, no unknown-tool problem. It cannot touch Claude sessions at all,
  and `/v1/compress` is stateless: upstream documents that a multi-turn caller
  must resend _previously forwarded_ messages with `frozen_message_count` or it
  busts the cache every turn. Right shape for a fallback, wrong shape for the
  real win.
- **`before_provider_request` in a bundled extension** — replaces the payload in
  pi's path only, so it is exactly as Claude-blind as the `context` event, and
  pi calls it "mainly useful for debugging".

## Out of scope

Headroom's cross-agent memory, `headroom learn` (it writes `CLAUDE.local.md`
and `CLAUDE.md` — pidex owns its directive stack), the budget/rate-limit/
semantic-response-caching features (a response cache in front of a coding agent
serves stale answers), and anything in `docs/specs/build/`.
