# The context meter froze for a whole turn on openai-codex

## Symptom

A `gpt-6-astra` session (`openai-codex`, i.e. GPT-6 on a ChatGPT
subscription) sat at **543 / 272k · 0%** for the entire turn while it spent
**5.7M cache-read tokens and $9.02**. Its real context at the moment of the
screenshot was **128,736 tokens — 47% of the window**, a 237× under-report.

The composition rows below it were nonsense too: a **41-token system prompt**,
**43 tokens for 31 tool schemas**, **5 tokens for 7 MCP servers**. And the
Session column read **Messages 1 · Tool calls 0** beside those millions of
tokens.

## Cause

Not pi. pi's own figure was correct throughout — a probe turn's
`get_session_stats` answered `8477 / 272000 · 3.12%`, and the session file's
last assistant message carries `totalTokens: 128736`. The window (272,000 for
`gpt-6-astra`) was right as well.

The failure was entirely in `src/lib/liveStats.ts`, and it was a regression
from the delta-usage optimization that made Claude sessions cheap to meter
([log](2026-09-01-session-reaper-and-live-stats.md#stats-from-the-stream-instead-of-26-round-trips-per-turn-s5)).

**The OpenAI Responses API reports usage only when the response completes.**
Measured against the live endpoint: 9 SSE events for one turn, and only the
9th — `response.completed` — carries a `usage` object. pi's `finalizeResponse`
is the sole writer of `output.usage`, so for the whole stream that object stays
at its initialized zeros.

That produced the worst of both worlds, confirmed on the RPC wire with a real
codex turn (3 `message_update` frames, 3 carrying a `usage` **field**, 0
carrying a nonzero token count):

1. `recordUsageDelta` only checked that `usage` **existed**, so
   `hasUsageDeltas` flipped true and `shouldRefreshStatsOn` narrowed polling to
   `agent_end` / `compaction_end`. The mid-turn poll that had been carrying the
   meter was switched off.
2. `overlay()` guarded the streaming estimate on
   `contextTokensOf(current) > 0`, which was false forever.
3. `recordMessageEnd` received the real final usage but folded it only into
   `base` (the token totals, which is why those stayed correct) and never
   touched `contextUsage`.

So nothing advanced the estimate until the turn ended — and the captured
session was **one turn**: 1 user message, 61 assistant messages, 94 tool
results, 95 tool calls. `agent_end` never fired. The meter kept showing the
bootstrap poll's 543 tokens, which is the char/4 estimate of the user's prompt
alone, taken before any assistant usage existed.

Claude escapes this because Anthropic sends `input_tokens` and cache reads on
the first frame, so `current` is nonzero from delta #1 and the overlay works as
designed. **codex is the first provider in the tree that reports usage only at
completion**, which is why the assumption held until now.

The absurd component rows follow from the same single cause: `breakdownSlices`
clamps its estimates **down** to fit pi's total
([log](2026-09-09-context-meter-provider-overhead.md)), so a total of 543
crushed every slice by roughly 100×. Correct code, poisoned input.

## Fix

`overlay()` now takes the context estimate from the **newest true reading**
rather than from the streaming message alone: `current` when it has reported
anything, else `lastEnded` — the final usage of the last assistant message to
end since the last poll. `message_end` carries authoritative usage on every
provider, and pi emits one assistant message per tool hop, so for codex that is
a fresh true reading per hop (61 of them in the session above) **at no
round-trip cost**. For a provider that streams usage, `current` always wins and
the new arm is inert.

Two properties keep it honest:

- **`recordPolledStats` clears `lastEnded`** alongside `current`. pi's answer is
  the ground truth for context, so a reading banked before it must never
  outrank it. This is what preserves the post-compaction behaviour: pi reports
  null tokens after a compaction, Phosphor polls on `compaction_end`, and the
  huge pre-compaction reading is dropped rather than outliving the reset.
- **A message that ended having spent nothing is ignored** — pi skips exactly
  those in `getAssistantUsage`, and an aborted or errored hop must not reset the
  meter to zero.

`hasUsageDeltas` was deliberately left alone. Making it demand a _nonzero_
delta would have been the other obvious fix, but it would re-enable ~26 polls
per turn for codex to buy something `message_end` already provides for free.

## Verification

`src/lib/liveStats.test.ts` grew a `describe` block for completion-only
providers, using the real captured numbers so a regression reproduces the
actual failure. Four of its cases fail against the old `overlay()` and the
16 pre-existing cases stay green, including the Claude-shaped and
post-compaction ones.

## Still open

Two things this change does not address.

**The stale Session counts.** `overlay()` passes `totalMessages` and
`toolCalls` through from the last poll, so mid-turn they still read
`Messages 1 · Tool calls 0`. Advancing them locally means counting toolResults
and user messages that arrive on other events, which is a different and more
error-prone change than this one; it is deliberately not bundled here.

**Codex plan limits do not exist yet.** `pi-claude-cli` pushes a
`claude-rate-limit` status key and `ContextMeter`'s `PlanLimits` renders it;
codex sessions show nothing. They could show more than Claude's, for less
work: the Codex backend already returns a full rate-limit header family on the
exact `POST /backend-api/codex/responses` that pi already makes — measured
2026-09-09 with pi's own header set (`originator: pi`):

```
x-codex-primary-used-percent: 30        x-codex-plan-type: self_serve_business_prolite
x-codex-primary-window-minutes: 10080   x-codex-active-limit: premium
x-codex-primary-reset-at: 1789520766    x-codex-credits-has-credits: False
x-codex-secondary-used-percent: 0       x-codex-credits-unlimited: False
```

pi discards all 17 of them — there is no `x-codex-` match anywhere in its
bundle, and its only rate-limit awareness is a 429 error-text matcher. Unlike
the Claude path this needs no subprocess, no 60 s cache and no extra request,
and it exposes **two** windows plus credits at any percentage rather than only
the one window whose threshold has already tripped. But HTTP response headers
are not visible to a pi extension, so it cannot be a `pi-ext/` file: it is a
change to `@earendil-works/pi-coding-agent`, which this repo does not own.

Ruled out as alternatives: `GET /backend-api/codex/usage` is Cloudflare-gated
(403 on repeat calls), and a malformed POST that 400s returns none of the
headers — they ride real requests only.
