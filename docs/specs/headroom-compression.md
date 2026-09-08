# Headroom as a first-class Phosphor feature

**Status: phases 1–3 SHIPPED (phase 1: `pi-ext/headroom.ts`, 2026-09-07;
phases 2–3: fold + Optimization tab + proxy supervisor, 2026-09-08 — see
[docs/log/2026-09-08-optimization-surface.md](../log/2026-09-08-optimization-surface.md));
4–6 (Layer 2) DEFERRED — decided 2026-09-07.**
Research done 2026-09-07 against Headroom 0.37.0 (`headroom-ai`, Apache-2.0,
repo at `e67b3c8`), pi 0.84.2 and pi-claude-cli 0.7.0. The proxy was run
locally and measured on this repo's own tool output; every trap below comes
from Headroom's source or wiki, not its README.

## What first-class has to mean

Phosphor runs two harnesses and they fail differently.

| Harness       | Who runs a tool                                                             | pi's hooks see    | The HTTP layer sees           |
| ------------- | --------------------------------------------------------------------------- | ----------------- | ----------------------------- |
| pi native     | pi                                                                          | every tool result | every request                 |
| pi-claude-cli | the CLI for `Read Write Edit Bash Grep Glob`; pi for `mcp__custom-tools__*` | MCP results only  | every request, inside the CLI |

The split is enforced by `isHandoffClaudeTool()` in pi-claude-cli's
`tool-mapping.ts`, and `pi-ext/worktree-paths.ts` already records it. Headroom
has no hook-based answer for the CLI half: its Claude Code plugin
(`plugins/headroom-agent-hooks`) is two hooks that run `headroom init hook
ensure` and nothing more. Every documented Claude Code path is the HTTP proxy.

So the design is two layers.

## Layer 1 — `pi-ext/headroom.ts`, the safe default

A sixth bundled extension on pi's `tool_result` hook. Compresses one tool
output as it is produced and returns the shorter text.

Covers every tool on pi native, MCP connector results on pi-claude-cli.

It is the default because a compressed result is written once and never
rewritten, so every earlier message keeps its exact bytes and prefix caching
cannot break — and because nothing but tool output ever crosses the socket.

- **Gate.** Inert unless `PHOSPHOR_HEADROOM_URL` is set. One `GET /health` at
  first use; failure disables it for the session.
- **Hook.** `pi.on("tool_result")` — chains like middleware, accepts a partial
  patch of `{content, details, isError, usage}`. Text parts only.
- **Eligibility — JSON only, and that rule is load-bearing.** Skip `isError`
  (the error text _is_ the payload), skip under ~1k tokens, skip
  `read`/`write`/`edit`/`bash`, and require the text to parse as a JSON
  object or array. As-built this SUPERSEDES the earlier plan to compress
  `grep`/`find`/`ls`: measured against a 0.37.0 proxy with the ml+code
  extras, plain text routes to transforms that are lossy WITHOUT saying so —
  `code_aware` kept 3% of a grep result and `kompress` deleted words from
  `git log` prose ("design the Optimization surface" → "design Optimization
  surface") with no marker and no hash. Valid JSON is lossless-or-noop on
  this endpoint by construction: the lossy row-sampling path is suppressed
  when no CCR store exists, so heterogeneous JSON comes back `router:noop`
  byte-identical. One `JSON.parse` enforces this regardless of how an
  adopted proxy is configured.
- **Accept-or-discard.** Keep the compressed text only if it is smaller _and_
  carries no unretrievable omission marker (second layer behind the JSON
  gate). The phase-3 supervisor adds a third: start the managed proxy with
  `HEADROOM_COMPRESSORS=smart_crusher,tabular`.
- **Fail open twice.** 3 s timeout on `ctx.signal`, plus a circuit breaker —
  upstream's own `HeadroomContextEngine` has one. Far inside `HANDOFF_WAIT_MS`
  (30 min), the ceiling on a blocked Claude CLI handoff.
- **Say so.** Cumulative savings on `ctx.ui.setStatus` under `Phosphor-headroom`,
  rendered in the context meter. Also needs `STRUCTURED_STATUS_KEYS`.
- **No `headroom_retrieve` tool.** No hashes exist on this path, so it could
  only ever error.

## Layer 2 — provider routing, opt-in per harness

Point model traffic at `127.0.0.1:8787`. The only thing that reaches Claude
Code's own `Read`/`Bash`/`Grep` output, and the only configuration where CCR
works at all.

- **pi native:** a `baseUrl` override on the built-in provider in
  `models.json`. pi documents that built-in models and existing OAuth keep
  working.
- **pi-claude-cli:** `ANTHROPIC_BASE_URL` on Phosphor's own `spawnEnv` — never
  `headroom wrap` or `headroom init` (trap 1).

Cost: the provider credential transits a third-party local process that holds
it in memory (trap 2).

## Measured, on this repo

`POST /v1/compress`, one tool result per request, model `claude-sonnet-4-5`,
proxy with `[proxy,ml,code]`.

| Tool output                         | Before  | After   | Saved | Latency | Transform   |
| ----------------------------------- | ------- | ------- | ----- | ------- | ----------- |
| MCP JSON, 120 Linear-shaped records | 30,203  | 14,075  | 53%   | 67 ms   | restructure |
| MCP JSON, 2,000 records             | 218,720 | 142,747 | 35%   | ~1 s    | restructure |
| `grep -rn session src/ electron/`   | 46,796  | 34,158  | 27%   | 42 ms   | drop        |
| test log, 4k lines, seeded failures | 126,978 | 34,049  | 73%   | ~1 s    | drop        |
| uniform 4k-line log                 | 127,020 | 32      | 100%  | ~120 ms | drop        |
| `git log --stat -n 40`              | 19,318  | 19,318  | 0%    | 5 ms    | noop        |
| `read` of a 9.4 KB `.ts` file       | 2,377   | 2,377   | 0%    | 3 ms    | excluded    |

The zeroes are deliberate upstream behaviour. `wiki/LIMITATIONS.md` documents
code as passthrough behind `protect_recent_code=4` and
`protect_analysis_context`, because code is fetched to be worked on.

Re-measured 2026-09-07 with the ml+code extras installed and REAL connector
payloads (the first table used synthetic uniform records — too optimistic):

| Payload                                       | Before | Saved | Transform                       | L1 verdict                   |
| --------------------------------------------- | ------ | ----- | ------------------------------- | ---------------------------- |
| live mcpScript field projection (Bedrock run) | 2,875  | 44%   | lossless CSV                    | accepted, receipt persisted  |
| synthetic uniform 120 records                 | 9,498  | 38%   | lossless CSV                    | accepted                     |
| real Notion search, 10 records                | 1,920  | 9.7%  | lossless CSV                    | accepted                     |
| real `linear list_issues`, 60 records, 102 KB | 33,325 | 0%    | `router:noop` (hetero + prose)  | nothing to accept            |
| same payload after pi's ~50 KB MCP truncation | 16,906 | 0%    | `router:noop` (invalid JSON)    | refused by the parse gate    |
| `grep -rn`, 257 KB                            | 66,946 | 97%   | `code_aware` — silently lossy   | refused by the JSON gate     |
| `git log --stat -n 40`                        | 18,317 | 33%   | `kompress` — deletes words      | refused by the JSON gate     |
| `grep -rn` with `config.mode: "ccr"`          | 66,946 | 97%   | `code_aware` + retrievable hash | future phase (retrieve tool) |

Where the savings actually come from: the JSON SCAFFOLDING — repeated key
names, quotes, braces, commas. Byte anatomy: the synthetic uniform array is
46% scaffolding → 38% saved; Notion records are 22% scaffolding → 9.7%;
real Linear issues are nested, 7 distinct key-sets, description-heavy → below
SmartCrusher's 15% lossless gate → noop. Corollary the Advisor should teach:
FIELD PROJECTION (an mcpScript that emits only the fields it needs) both
shrinks the raw payload and makes the remainder uniform enough to compress —
the live Bedrock run did exactly this and got 44% on top of the projection.

**Restructure is safe.** JSON becomes a typed schema header plus CSV rows;
verified by counting identifiers, 120 of 120 records survived, and 500 and
2,000-record arrays behaved the same.

**Dropping is not — but the wiki's "CCR is proxy-only" claim is stale.**
0.37.0's `/v1/compress` accepts `config.mode: "ccr"`: the same grep result
then returns a `hash=` marker, writes a store entry, and
`GET /v1/retrieve/<hash>` returns the full original — round-trip verified
2026-09-07. So the "CCR on the stateless endpoint" partnership ask is
already shipped; what remains is OUR side (register a `headroom_retrieve` pi
tool, budget the store TTL of 1800 s), which is a future phase, not an
upstream dependency. Until then the default marker-free mode plus the JSON
gate is what ships.

## Detect, install, run, check

**Detect.** `headroom --version` on the login-shell PATH Phosphor already
resolves; `GET /health` for liveness and `checks.kompress.ready` for
capabilities; `headroom doctor --json` (exit 0 pass / 1 warn / 2 fail) for
diagnosis. Mirror `electron/pi/health.ts` as `electron/headroom/health.ts`,
and keep pi's rule: reads never spawn anything.

**Install, never silently.** `headroom-ai[proxy]` resolved to a 503 MB venv;
`[ml,code]` took it to 1.4 GB. The npm package is only an HTTP client to the
Python service, so there is nothing lighter to bundle. Show the command, then
stream it over the same job pattern the packages tab already uses:

```
headroom:install(extras) → { jobId }
  → chunks on  headroom:output:<jobId>
  → exit code on headroom:exit:<jobId>
```

**Run.** Main process owns it, one proxy per machine:

```
headroom proxy --port 8787 --no-subscription-tracking
env: HEADROOM_BEACON=off  DO_NOT_TRACK=1  HEADROOM_UPDATE_CHECK=off
```

Adopt an existing proxy if `/health` already answers — the user may have run
`headroom install apply`, and a second proxy on a second port silently splits
the savings. Never outlive the app. Fail open on start.

**Check.** A Settings section answering four questions: installed, running,
routed, saving how much. The last is free once layer 1 pushes its status key.

## Validated 2026-09-07

Live end-to-end runs, not `/v1/compress` replays. Fixture: 100 Linear-shaped
issues (~10.2k tokens), questions with a known exact answer.

| Path                                                           | Result                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 on pi native (OpenRouter haiku, real turn, probe extension) | works — hook fired mid-turn, 10,172→5,595 tokens (45%, 41 ms), model answered exactly from compressed text                                                                                                                                                                                                                                  |
| L1 on pi-claude-cli (custom tool through the handoff broker)   | works — 10,167→5,590 (22 ms) inside the blocked CLI turn, exact answer                                                                                                                                                                                                                                                                      |
| L1 fidelity                                                    | 100/100 rows survive; a wrong count by haiku reproduced identically UNcompressed — model error, not ours                                                                                                                                                                                                                                    |
| L2 claude CLI through the proxy (subscription OAuth)           | works; `--model` survives per invocation (haiku and sonnet both served as requested) — trap 4 does not bite Phosphor's pinned-model path                                                                                                                                                                                                    |
| Trap 3 measured with a bare recording proxy (no Headroom)      | 30 tools / 97,959 B of schemas without the flag vs 13 tools / 44,540 B with `ENABLE_TOOL_SEARCH=true` (~13k tokens per request); Headroom itself also stripped ~15k/request of schema when in the loop                                                                                                                                      |
| L2 pi native (built-in `openrouter` `baseUrl` override)        | works, existing auth kept working, exact answer — but live-turn message compression was ~0.2%: upstream recency protections spare the newest tool result, so L2's in-turn win is schema stripping; history compression needs long sessions and is untested                                                                                  |
| Bedrock (`--backend bedrock`)                                  | works end-to-end (re-run 2026-09-07 on PowerUserAccess). Direct `/v1/messages` invoke, pi native via a custom `anthropic-messages` provider, the Claude CLI via `ANTHROPIC_BASE_URL` with the model honoured, and the full stack — L1 probe + Bedrock routing in one live tool-calling turn (10,171→7,369, 14 ms, exact answer) — all green |

Bedrock notes from the run: models must be addressed by inference-profile id
(`us.anthropic.…`), the same as pi direct. And pi's `anthropic-messages`
client appends `/v1/messages` itself, so the provider `baseUrl` must be the
bare origin (`http://127.0.0.1:8803`) — with `/v1` appended you get a 404.

Untested still: many-turn history compression through the proxy, concurrent
sessions against one proxy, RPC-mode (vs `-p`) integration, and a live
two-account run against one proxy (source-verified only, below).

Two conclusions the tests add: L1 is not just the safer layer, it is the
_stronger_ one for fresh tool results — the proxy's own recency protections
mean it barely touches the newest tool output in-turn, while L1 compresses it
at the source. And trap 4 is narrower than upstream's warning: it applies to
the CLI's interactive `/model` picker, not to a model pinned per invocation,
which is the only thing Phosphor does.

## Phase 1 as-built validation (2026-09-07)

The shipped extension (`pi-ext/headroom.ts`), loaded with `-e` into live
`pi -p` runs against a local 0.37.0 proxy:

| Provider                                  | Result                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| amazon-bedrock (sonnet 4.5)               | accepted live: 2,875 → 1,618 tokens (44%, 18 ms) on an mcpScript projection; `details.headroom` receipt in the session JSONL                                               |
| pi-claude-cli (haiku 4.5, handoff broker) | accepted live inside the blocked CLI handoff (21 ms); receipt persisted; turn continued                                                                                    |
| openrouter (sonnet)                       | accepted live: 2,889 → 1,633 tokens (43%, 26 ms), receipt persisted, exact answer; the instrumented run also verified the correct no-op on an incompressible 51 KB payload |

The receipt persistence question from optimization-surface.md is answered:
pi persists a `tool_result` handler's `details` patch verbatim into the
session file, so per-lane savings can be folded from disk (phase 2a).

Also validated: a real programming task ran in the Phosphor worktree on
pi-claude-cli with the extension loaded (wrote
`src/features/chat/composer/headroomStatus.test.ts`, 8/8 green) — the
feature does not disturb ordinary work.

Two traps found by the live runs, added here so they are not re-derived:

- **pi truncates MCP tool output at ~50 KB** (mid-byte, with a
  `[MCP text output truncated …]` notice and a temp-file pointer). The hook
  runs AFTER that cut, so oversized connector results arrive as invalid JSON
  and are refused by the parse gate. Headroom cannot recover what pi already
  cut; if compress-before-truncate is ever wanted, that is a pi-side ask.
- **The default marker-free mode is silently lossy for plain text** when the
  ml/code extras are installed (see the re-measured table). Any future
  widening beyond JSON must go through `config.mode: "ccr"` plus a
  registered retrieve tool, never through the default mode.

## Multiple Claude accounts

Phosphor runs pi-claude-cli under several accounts at once, selected per spawn by
`claudeAccountEnv()` (`CLAUDE_SECURESTORAGE_CONFIG_DIR` + pinned org UUID).
Each CLI process reads its own keychain entry and sends its own OAuth bearer.
Read against Headroom 0.37.0 source:

- **Layer 1: no interaction at all.** No credential crosses the socket; the
  compress endpoint sees tool text and a model name.
- **Layer 2 forwarding is per-request.** `proxy/handlers/anthropic.py` forwards
  the incoming request's own `authorization` / `x-api-key` upstream (only
  `x-headroom-*` headers are stripped). Two accounts through one proxy each
  keep their own token; nothing is cached on the forwarding path. The rate
  limiter even buckets by token prefix, so accounts get separate buckets.
- **The subscription tracker is the one single-token assumption.**
  `notify_active()` overwrites `self._current_token`, so with two accounts it
  would poll `api.anthropic.com/api/oauth/usage` with whichever token arrived
  last — wrong-account attribution. `--no-subscription-tracking` (already
  mandatory, trap 2) upgrades from privacy hygiene to a correctness
  requirement.
- **The CCR store is content-hash keyed, global per proxy.** No account or
  session partitioning: content compressed in one session is retrievable from
  another. Same machine, same human, same trust domain — acceptable, but it is
  a reason one Phosphor-managed proxy should never be shared beyond the local
  user (it binds 127.0.0.1, so it isn't).

Verdict: multi-account is not a blocker for any phase. One proxy per machine
stands.

## Traps

1. **Never `wrap` / `init` / `install --providers`.** Upstream's provider
   adapters write `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`
   (`wiki/persistent-installs.md`) and `wrap claude` persists it into
   `.claude/settings.local.json` in the cwd. A proxy that dies uncleanly then
   bricks a plain `claude` with ConnectionRefused — upstream ships
   `_selfheal_dead_wrap_base_url()` on a SessionStart hook to undo exactly
   this. The global file changes the user's own CLI outside Phosphor; the
   project-local one would land in every worktree. Phosphor sets env on its own
   spawn only.
2. **The proxy keeps the Claude OAuth token.** `subscription/tracker.py`
   stores the raw bearer (`self._current_token = raw`) and polls
   `api.anthropic.com/api/oauth/usage` with it every 300 s. Destination is
   Anthropic, not Headroom Labs, so this is not exfiltration — but it is an
   unrequested second use of the credential, and Phosphor already gets rate-limit
   state from pi-claude-cli. Mitigation: `--no-subscription-tracking`,
   non-negotiable if layer 2 ships.
3. **A custom base URL inflates Claude Code's context.** Upstream issue #746:
   the CLI disables on-demand tool loading when `ANTHROPIC_BASE_URL` is custom
   and `ENABLE_TOOL_SEARCH` is unset, "which inflates the local context window
   by tens of K tokens." Set `ENABLE_TOOL_SEARCH=true` beside it and verify on
   the context meter.
4. **The model picker does not survive a custom base URL.** Upstream's
   `cli/wrap.py` says `/model` selection "does not survive", which is why
   their `--1m` flag forces `ANTHROPIC_MODEL`. Phosphor sets a model per session
   and shows it on a chip. Verify before phase 5 — a chip that lies is worse
   than no compression.
5. **Bedrock does not pass through.** With `CLAUDE_CODE_USE_BEDROCK=1` the CLI
   calls Bedrock directly through the AWS SDK and ignores `ANTHROPIC_BASE_URL`
   entirely (`docs/claude-code-bedrock-headroom.md`). The supported shape is
   `CLAUDE_CODE_USE_BEDROCK=0` plus `headroom proxy --backend bedrock`. Same
   for pi native: SigV4 signing means a `baseUrl` override cannot work, so a
   Bedrock session needs an `anthropic-messages` provider pointed at Headroom.
   Verified end-to-end 2026-09-07 on both harnesses; the remaining question is
   policy (Headroom holds the AWS credentials), not mechanism.
6. **Whole-history compression busts the prefix cache.** pi's `context` event
   maps 1:1 onto upstream's `HeadroomContextEngine.assemble()`. `wiki/proxy.md`
   requires a stateless caller to pass `config.frozen_message_count` _and_
   resend previously-forwarded messages or it "silently destroys the
   provider's prefix cache"; upstream's own plugin passes neither. Layer 1's
   per-result design sidesteps the parameter entirely.
7. **Two Claude auth keys are mutually exclusive.**
   `claude_auth_conflict_sources()` treats `ANTHROPIC_API_KEY` and
   `ANTHROPIC_AUTH_TOKEN` as contradictory. Phosphor already writes account env
   through `claudeAccountEnv()`; check the overlay before adding a writer.
8. **Transport interception is not an option.** Upstream's opencode plugin
   monkeypatches `fetch`, `http`, `https`, `http2` and
   `child_process.spawn/exec/execFile/fork`, injecting
   `NODE_OPTIONS=--import=<shim>` so children are patched too. It would reach
   the Claude CLI, but `shouldRoute()` sends every non-loopback request through
   the proxy, and pi is a process Phosphor spawns and depends on. Recorded so it
   is not re-derived.

## Delivery

1. **The extension, inert.** Layer 1 as specified, wired into
   `bundledExtensions()`, provably a no-op with no env var.
   Files: `pi-ext/headroom.ts`, `pi-ext/headroom.test.ts`,
   `electron/ipc/pi-session-handlers.ts`, [../extensions.md](../extensions.md),
   [../../README.md](../../README.md) (the two "five extensions" counts).
2. **Detect and install.** `electron/headroom/health.ts`, a Settings tab with
   the not-installed state and the guided install job. No traffic touched.
3. **Proxy lifecycle + savings surface.** Main-process supervisor, flip
   `PHOSPHOR_HEADROOM_URL` into `spawnEnv`, savings row in the context meter.
   First release where anything is actually compressed.
4. **Layer 2 for pi native.** `baseUrl` override. Verify pi's default
   `eager_input_streaming: true` survives, else set
   `compat.supportsEagerToolInputStreaming: false`.
5. **Layer 2 for pi-claude-cli.** `ANTHROPIC_BASE_URL` +
   `ENABLE_TOOL_SEARCH=true` on Phosphor's own spawn. Trap 4 verified harmless
   for Phosphor's pinned-model path (guard test only); remaining gate is the
   explicit call about trap 2.
6. **Bedrock, both harnesses.** `headroom proxy --backend bedrock`; pi native
   gets a generated `anthropic-messages` provider entry with a **bare-origin**
   `baseUrl`, pi-claude-cli gets `CLAUDE_CODE_USE_BEDROCK=0` +
   `ANTHROPIC_BASE_URL`. Mechanism fully verified 2026-09-07; gated only on
   accepting that Headroom holds the AWS credentials for these sessions.

Phases 1–3 need no decision. 4–6 need the credential calls — and are
**deferred** (decision 2026-09-07): routing pi's provider traffic through the
proxy risks breaking things Phosphor depends on (model listing among them) for
an in-turn win that measured ~0.2% on live traffic. Revisit only after
phases 2–3 land and with a specific breakage test plan for pi's model
discovery and streaming paths.

## Asks for Headroom

The integration surface that would make this clean, ranked.

| Ask                                                                       | Unlocks                                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **CCR on `/v1/compress`** — return hashes, honour `/v1/retrieve/<hash>`   | Turns layer 1 reversible. The one change that lets us stop excluding `bash` and logs, where the largest untapped savings are. |
| **A credential-free routing mode** — never read or retain `authorization` | Removes the whole objection to layer 2; it becomes a toggle instead of a security review.                                     |
| **A per-request transform allowlist** — e.g. `config.allow_lossy: false`  | Server-side guarantee instead of our client-side omission-marker heuristic.                                                   |
| **A slimmer install** — proxy-only, no torch                              | 1.4 GB is the biggest desktop adoption barrier; structural compression already delivered most of what we measured.            |
| **An env-only integration contract** — documented, no config-file writes  | Makes Phosphor a clean citizen and removes the stale-base-URL failure entirely.                                               |
| **A pi package** — publish the extension jointly                          | Layer 1 for every pi user, not just Phosphor, and a harness they do not currently list.                                       |
