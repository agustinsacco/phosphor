# 2026-08-22 — What's in the context window, and what's left of the account

Two questions the app could not answer about its own state. pi reports
context usage as a single number — "128k / 200k" tells you _how full_ and
never _full of what_ — and for sessions running on a Claude subscription
there was no way to see the plan window at all: the same "Claude Opus 5"
label appears whether it came from pi's Anthropic path or through the Claude
Code CLI, and only one of those spends plan quota.

Shipped as [#42](https://github.com/agustinsacco/Phosphor/pull/42) (composition)
and [#45](https://github.com/agustinsacco/Phosphor/pull/45) (plan limits), both
into the context meter's popover.

## Composition: measured where the parts actually exist

The pieces that fill a context window — the composed system prompt, the
active tool schemas — are assembled **inside pi** and are not reachable from
the renderer through any RPC. So the measurement moved to where the data
lives: `pi-ext/context-breakdown.ts`, a bundled extension loaded into every
session, publishing a breakdown on the `phosphor-context-breakdown` status key.

Provider-agnostic by construction. It reads pi's own state, so it works
identically for local models, native Anthropic and the Claude Code CLI —
this is not a Claude feature that happens to also work elsewhere.

Two mistakes that each survived until a live run:

- **`getActiveTools()` returns names, not schemas.** Sizing the active list
  reported ~4 tokens for a tool set that really costs 638. Sizes must come
  from `getAllTools()` (definitions, with schemas); the active list is only
  a filter. Unit tests could not catch this — both calls return arrays.
- **Publishing mid-stream** walks the whole branch on every token. It now
  publishes at rest only: `session_start`, `agent_settled`, `turn_end`.

**The honesty constraint.** No tokenizer is reachable from an extension, so
component sizes are character-based estimates. Only pi's total is real.
`breakdownSlices` scales the estimates onto that total, free space is the
remainder rather than a fifth estimate, and the popover says "approximate".
The alternative — four confident-looking numbers that don't sum to the
total — would be worse than the single number we started with.

## Plan limits: account state, off the transcript path

The Claude Code CLI emits a `rate_limit_event` on **every turn** that the
provider was silently dropping. It now forwards it (`onRateLimit`) and
publishes it on the neutral `claude-rate-limit` key — neutral rather than
`Phosphor-*` because it is account state any pi front-end can use. Provider
0.4.5; the payload and its rules are documented in that repo's
`docs/ARCHITECTURE.md`.

Two invariants have tests in the provider repo, because both would be quiet
failures: account state must never become turn content (it would land in the
user's transcript _and_ in pi's session file on disk), and a host callback
that throws must not break the turn it rode in on.

Renders only when the key is present, so every other provider shows nothing
— no provider allow-list in the UI, which is what makes this survive the
next provider we add.

**What it deliberately does not show: utilization percentages.** The "12% of
your 5-hour limit" in Claude Code's own TUI comes from
`anthropic-ratelimit-unified-*` **response headers**, which the CLI consumes
in-process and never writes to stdout. Getting them means Phosphor making
authenticated Anthropic requests with the user's credentials — the same line
we declined to cross when we chose to route inference through the CLI rather
than borrow its tokens. So the chip answers "when does capacity come back",
not "how much is left", and says so.

## Verified

Live, against a real Max account through pi in RPC mode — the payload the
unit tests assert on is a capture, not a fixture written by hand:

```json
{
  "status": "allowed",
  "resetsAt": 1787368800,
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "isUsingOverage": false
}
```

## Consequences for later work

The status channel now carries two cross-boundary contracts, one of them
across a repo boundary with no compile-time guard. Both are tabulated in
[12-extensions.md](../extensions.md#the-status-channel-is-a-wire-contract);
the parsers return `null` on anything malformed so a bad push degrades to a
missing section.

This is also the groundwork for multi-account round-robin: `CLAUDE_CONFIG_DIR`
isolates Claude accounts (verified), and now that `resetsAt` is captured per
account, a routing policy can prefer the account whose window isn't
exhausted instead of rotating blind.
