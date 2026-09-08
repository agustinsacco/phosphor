# 2026-08-30 — Review: always-on Claude usage stats (live plan bars)

Claude Desktop shows account usage all the time — bars for how much of the
5-hour and weekly allowance is spent, per session and per week. Phosphor shows
the `claude-rate-limit` state only once the CLI's warning threshold has
been crossed, which is the moment the number is least useful for planning: you
want to see yourself approaching the wall, not the wall.

This is a review of every data source that could power an always-on view,
and a concrete design for the two surfaces we want to feed: the context
meter's popover (next to the input) and the Claude Code tab in Settings.
The headline, found while digging past the obvious dead ends: **
`claude -p /usage` prints Claude Desktop's own live numbers — every window,
with percents, zero quota, no key, for every signed-in account.** That
becomes phase 1; the Admin API
([retrieve_claude_code](https://platform.claude.com/docs/en/api/admin/usage_report/retrieve_claude_code)),
reviewed in detail below, becomes the optional org-level phase 2.

## What the sources actually give us

### 1. The CLI's `rate_limit_event` — every turn, but percent-gated

Verified empirically against Claude Code 2.1.231 / provider 0.4.16, under
threshold, print mode:

```
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1788115800,"rateLimitType":"five_hour",
  "overageStatus":"rejected","isUsingOverage":false}}
```

The event **does arrive every turn** — the "only after 90%" gating applies to
`utilization`, not to the event. Under the threshold the payload carries the
binding window's type and reset, but no fraction. The fraction lives in
response headers (`anthropic-ratelimit-unified-{claim}-utilization`,
`-reset`, `-surpassed-threshold`) that the CLI parses inside its own process
and only forwards once a warning step (`allowed_warning` →
`surpassedThreshold`) has tripped. Phosphor never sees those headers, and no
fork change can surface them before the CLI decides to.

So from this stream, always-on, we can know: which window binds (5h → 7d →
7d-overage → credits) and when it resets. We cannot know "42% used" until the
CLI starts warning — source 2 is how we get that.

### 2. The Claude Desktop bars — an internal endpoint, but the CLI exposes its output

The CLI's own `/usage` panel (what Claude Desktop's numbers mirror) fetches
`GET https://api.anthropic.com/api/oauth/usage` with the logged-in user's
OAuth token, auto-refreshed on 401. That endpoint is undocumented and
first-party-only, and the OAuth token belongs to the `claude` binary in the
OS keychain — Phosphor never holds it, by design (the account row in Settings
says exactly this: the credential is the CLI's, not Phosphor's).

**But the CLI prints that panel in print mode.** Verified against 2.1.231:

```sh
cd /tmp && echo "" | claude -p "/usage" --output-format json
```

returns, with `num_turns: 0`, `total_cost_usd: 0`, `duration_api_ms: 0` —
**zero model calls, zero quota** — and a `result` field holding:

```
Current session: 27% used · resets Aug 30 at 2:49pm (America/Toronto)
Current week (all models): 50% used · resets Aug 30 at 3:59pm (America/Toronto)
Current week (Fable): 37% used · resets Aug 30 at 3:59pm (America/Toronto)
```

This is **live** server-side utilization (the percent moved 26% → 27%
between two runs a few minutes apart), it works for **any signed-in
subscription account** — Pro/Max personal included, no org, no admin key,
no credential ever handed to Phosphor — and it costs ~1.5–2 s of process spawn
per fetch. The `rate_limit_event`-stream gap (percent only after threshold)
and the keychain problem both dissolve: Phosphor spawns the CLI, the CLI uses
its own keychain, we parse its rendered answer.

The CLI binary's strings give the full window vocabulary behind the text:

| Internal kind                         | Rendered label                   |
| ------------------------------------- | -------------------------------- |
| `five_hour`                           | "Current session" (the 5h block) |
| `seven_day`                           | "Current week (all models)"      |
| `seven_day_<model>` / `weekly_scoped` | "Current week (<Model>)"         |
| `cinder_cove`                         | "Claude Code and Cowork credit"  |
| one-time credit                       | "One-time credit · Expires …"    |

Two failure modes are visible in the CLI's own code and must be handled:
it can serve **last-known** data ("Showing last-known usage (could not
refresh)") or fail outright ("Could not refresh usage data") — the usage
endpoint is rate-limited on Anthropic's side, which is also why Phosphor must
not poll it tighter than roughly a minute.

The rendered text is a wire contract in exactly the sense the repo already
maintains: parse narrowly, and hide the section rather than guess when the
shape drifts (same policy as the `[Claude Code · …]` marker contract).

**Still rejected:** reading the OAuth token out of the keychain to poll
`/api/oauth/usage` ourselves. Spawning `/usage` gets the same data through
a documented CLI surface without ever touching the credential — no reason
to take on an undocumented wire plus a credential the user never gave us.

### 3. The Admin API — documented, always-on, but different data

`GET /v1/organizations/usage_report/claude_code` is the documented org
endpoint for Claude Code analytics. It does not give plan-limit utilization
(no percent-of-weekly-allowance anywhere in the public API — the Spend Limits
API is Enterprise-only and monthly-spend, not the 5h/7d windows), but it gives
everything else: daily tokens by model, estimated cost, session counts,
commits, PRs, LOC. Full detail below.

## The endpoint in detail

**Request** (all params required unless noted):

- `starting_at` — `YYYY-MM-DD` UTC date. Returns metrics for **that single
  day only**; a week is 7 requests (or one per day as needed).
- `limit` — records per page, default 20, max 1000.
- `page` — opaque cursor from the previous response's `next_page`.

Headers: `anthropic-version: 2023-06-01`, `x-api-key: $ANTHROPIC_ADMIN_KEY`
(an Admin API key, `sk-ant-admin01-…`, created by an org admin in the
Console; an OAuth bearer token with `org:admin` scope also works). Docs ask
integrations to set a `User-Agent: Phosphor/<version>`.

**Response** — one row per (actor, `is_remote`) for the day:

- `actor` — `user_actor` with `email_address`, or `api_actor` with
  `api_key_name`. Rows are per user, **not per session**.
- `model_breakdown[]` — per model: `tokens.{input, output, cache_read,
cache_creation}` and `estimated_cost` in **minor units** (cents when USD —
  `amount: 186` is $1.86, not $186; the naive parse is a 100× bug).
- `core_metrics` — `num_sessions`, `commits_by_claude_code`,
  `pull_requests_by_claude_code`, `lines_of_code.{added, removed}`.
- `tool_actions` — accepted/rejected per edit tool.
- `customer_type` (`api` | `subscription`), `subscription_type`
  (`team`/`enterprise`/null), `terminal_type`, `is_remote` (Claude Code on
  the web is a separate row), `organization_id`.
- Pagination: `has_more`, `next_page` (null at the end). Don't change params
  mid-sequence; cursors are bound to the issuing query.

**Operational facts:**

- Data is **~1 hour behind** — only activity older than an hour is included,
  for pagination stability. This is a trailing dashboard, not a live meter.
- The Admin API is **unavailable for individual accounts** (Pro/Max personal
  logins have no org and no admin key). This feature is necessarily
  org-gated; the UI must say so rather than show a permanently empty widget.
- Free to call; 7 requests per weekly refresh is negligible, but we should
  still cache (see below) and never poll on a timer tighter than the data's
  own freshness.

## Design

Four sources, four honest renderings — never let a bar imply a denominator
it doesn't have:

| Question                            | Source                            | Rendering                                    |
| ----------------------------------- | --------------------------------- | -------------------------------------------- |
| How full is this session?           | pi `get_session_stats` (have)     | context % ring (have)                        |
| Am I near the plan wall — live?     | `claude -p /usage` (new, phase 1) | **% bars for 5h + weekly, always on**        |
| In-turn cap warning                 | `claude-rate-limit` status (have) | window + reset, banner past threshold (have) |
| How much did I use this week (org)? | Admin usage report (new, phase 2) | 7-day usage bars, tokens + est. cost         |

### Phase 1 — live plan bars via `claude -p /usage` (no key, every account)

**Main process — `electron/claude/usage.ts` + a pure parser.**

- Spawn `claude -p /usage --output-format json` following the repo's
  print-mode rules: **`stdio[0] = 'ignore'`** — the Aug-26 log's stdin-EOF
  lesson (`pi -p` hanging on an open pipe) applies to `claude -p` equally,
  and the guard belongs in a test beside `electron/pi/print-mode.test.ts`'s.
  ~1.5–2 s per call, `num_turns: 0`, zero quota.
- Parse the JSON envelope, then the `result` text. Line grammar:
  `<label>: <n>% used (· resets <MMM D at h:mm(am|pm)> (<tz>))?`, with
  labels `Current session`, `Current week (all models)`,
  `Current week (<Model>)`, `Claude Code and Cowork credit`, `One-time
credit · Expires …`. The reset text is the CLI's local-timezone rendering
  on this machine, so parse it as local time and sanity-check the result
  (future, within the window's span) — a mismatch is drift and hides the
  section, never a wrong number.
- Carry the CLI's own honesty flags through: a "Showing last-known usage"
  line marks the snapshot `stale: true` (rendered as "last known"), and "Could
  not refresh usage data" is an error, both surfaced instead of papered
  over.
- Cache with a 60-second TTL and fetch on demand — the popover opening is
  the natural trigger; the upstream endpoint rate-limits, so nothing polls
  tighter than that, and stale-while-revalidate makes the second open
  instant.

**IPC**: one channel, no args, no secrets —

```ts
'claude:usageSnapshot': {
  args: []
  result:
    | { ok: true; fetchedAt: number; stale: boolean
        windows: { label: string; percentUsed: number; resetsAt: number | null }[] }
    | { ok: false; error: 'not-signed-in' | 'unavailable' }
}
```

Handlers in `electron/ipc/claude-handlers.ts`, mock case in
`src/dev/mockPhosphor.ts` (a fixture snapshot keeps `dev:web` honest).

**Popover**: a real "Plan usage" section replaces `PlanLimits`' single
window: a bar per window the CLI reports — 5-hour and weekly always,
per-model weekly when present — each with percent and reset countdown,
colored on the same ≥75/≥100 thresholds everything else uses. Below it, the
binding-constraint line from `claude-rate-limit` stays: it is still the
only source that can say "capped NOW, resets in 12 min" mid-turn. Fetch on
popover open, shimmer while the ~1.5 s spawn runs.

**Settings → Claude Code**: a "Usage" section with the same windows larger,
plus the `What's contributing to your limits usage?` context from the same
`result` text (last 24h / 7d request and session counts, top
skills/subagents/MCP servers) — the parse gets it for free. Signed-out
accounts show the empty state.

**Tests** (`electron/claude/usage.test.ts`, fixtures in `__fixtures__/`):
captured live outputs for the ordinary case, the last-known case, the
failure case, per-model weekly lines, the one-time-credit line, and a drift
case (an unknown label) asserting the section hides rather than renders
garbage. Plus the stdin guard test.

This is everything Claude Desktop shows for limits — the same live endpoint,
the CLI's own rendering — through the one surface Anthropic documents.

### Phase 2 — optional org dashboard via the Admin usage report

The Admin API keeps the org story (weekly tokens/cost by model, commits,
PRs, LOC, per-actor) and no longer carries the live-percent burden, so it
can land whenever it is wanted. Main-process module —

Pure aggregation module + thin fetcher (network in `electron/`, per repo law):

- `fetchUsageReport(key, emails, now)`: 7 parallel GETs for the trailing
  7 UTC days, `limit=1000`, follows `next_page` while `has_more`; maps 401/403
  to "key rejected or account has no organization", 429 to "back off".
- Aggregation sums rows matching the signed-in account's email
  (`packages:claudeStatus` already exposes `auth.email` — same account the
  Claude Code tab reports). If no email matches, return everything with
  `scope: 'organization'` so the dashboard says whose numbers they are.
- Cache in-memory: 15-minute TTL. The upstream data is 1h stale; anything
  faster is waste, anything slower hides a day boundary unnecessarily.
- Key storage: Electron `safeStorage` (OS-encrypted blob in electron-store,
  lazy-constructed as `electron/store.ts` requires), key never enters the
  renderer, never into the debug log.

**IPC additions** (`shared/ipc.ts`, same handler module, mock cases):

```ts
'claude:usageReport':   { args: []; result: ClaudeUsageReport }  // cached-or-fetch
'claude:setUsageKey':   { args: [key: string]; result: { ok: true } | { ok: false; error: string } }
'claude:clearUsageKey': { args: []; result: void }
```

`ClaudeUsageReport` in `shared/models.ts`: `fetchedAt`, `scope`, `days[]`
(per day: tokens, costUsd, sessions, commits, PRs, LOC ±, remote split),
`totals`, `models[]`. Costs stored in the model as **major units** (divide by
100 at the parse boundary; minor units never leave the fetcher).

**Surfaces when configured**: the popover gains a compact 7-day cost-bar row
under the plan bars (Σ summary line, link into Settings), and the Settings →
Claude Code tab gains the key row (not set / saved / rejected, with the
note that keys are minted by an org admin in the Console — Teams/Enterprise/
API orgs only) plus the full weekly dashboard with per-model breakdown and
the core metrics that exist nowhere else (commits, PRs, LOC ±). Caveat line,
always: "daily UTC buckets, ~1 hour behind". Its failures join the tab's
"When it fails" list: 401/403 (wrong key, no org, individual account), 429
(back off), empty rows for the signed-in email (different account, or
Bedrock/Vertex deployments this API doesn't cover).

Tests: `electron/claude/usage-report.test.ts` against a captured fixture in
`__fixtures__/` (both actor kinds, a remote row, two pages): minor-unit →
dollar conversion, email scoping, pagination merge, missing-day handling
(no row ≠ zero usage — leave the day out), and the error mappings.

## What we are not doing, and why

- **No keychain token, no direct `/api/oauth/usage` polling** (Claude
  Desktop's literal source): undocumented wire, and the credential is the
  CLI's. Spawning `claude -p /usage` gets the same live data through a
  documented surface — strictly better.
- **No timers.** The snapshot fetches when a surface opens (60 s TTL); the
  org report when its dashboard is open. Nothing polls in the background:
  the usage endpoint rate-limits, and a hidden window fetching on a schedule
  is debug-log noise with nobody watching.
- **No synthesized plan-percentage from the Admin report.** There is no
  public denominator for the 5h/7d windows; Spend Limits is Enterprise
  monthly spend. Phase 1's percents come from the CLI's own rendering, not
  from us dividing one number by a guess.
- **No local transcript math** (`~/.claude/projects` JSONL, ccusage-style):
  unnecessary now — phase 1 covers personal accounts live — but it remains
  the fallback if `/usage` print output ever disappears. Noted so the
  option isn't rediscovered.
- **No fourth bar for a fourth window** from `rate_limit_event`: one event
  still carries one window (Aug 22 log). Phase 1 gets all windows from
  `/usage`; the event keeps its one honest job, the in-turn cap warning.

## Sequencing

1. **Phase 1 — live plan bars**: `electron/claude/usage.ts` spawn + parser +
   `claude:usageSnapshot` IPC, popover plan-usage section, Settings usage
   section. No key, no admin anything — works for every signed-in account.
2. **Phase 2 — org dashboard (optional)**: Admin usage report fetcher, key
   row, 7-day cost dashboard, popover mini-bars when configured.

Both are small; neither touches the provider package or a status-key wire
contract, so nothing here waits on `@saccolabs/pi-claude-cli`. The one
upstream risk is the CLI's `/usage` text format moving — that is what the
narrow parser and drift-hide tests are for.

## Shipped (same day, phase 1)

`electron/claude/usage.ts` (parser + cached fetcher, spawned through
`runPrintMode` so stdin is ignored per the Aug-26 rule), the
`claude:usageSnapshot` IPC channel, a "Plan usage" section in the context
meter's popover (above the old `PlanLimits`), and a Usage section in
Settings → Claude Code including the "what's contributing" block. Tests in
`electron/claude/usage.test.ts` run against a real captured fixture
(`__fixtures__/usage-live.json`); the e2e claude-tab test's stub now answers
`-p /usage`, so the spawn → parse → IPC → bar path is proven end to end.

Two deviations from the design above, both deliberate:

- **`PlanLimits` was kept, not replaced.** The live bars and the
  binding-constraint line answer different questions (percent vs "capped
  now, resets in 12 min"), and both render under one popover without
  competing — see `specs/reference/chat.md`'s popover table, updated in the
  same diff, for the rule that keeps them separate.
- **Phase 2 (org dashboard) is not built.** The subscriber of this work
  doesn't need org-level cost reporting; the Admin API review above stands
  on its own for whenever that changes.

Verified: typecheck, lint, prettier, full unit suite (1628), and the e2e
claude-provider-tab test — all green.
