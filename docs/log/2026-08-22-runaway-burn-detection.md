# Runaway-burn detection, and a status strip that stops printing JSON

2026-08-22

## What happened

On 2026-08-21, three concurrent Phosphor sessions consumed ~46M billed tokens in
roughly twenty minutes — peaking at 3.5M tokens/minute — and exhausted the
account's rate limit. Nothing in Phosphor remarked on it. The sessions looked
normal: the context meter sat at a plausible percentage while the provider
spent the entire budget re-sending context it had already delivered.

Root cause was outside Phosphor, in the `@saccolabs/pi-claude-cli` provider:
`buildResumePrompt` anchored its resume delta on the last _user_ message, but
pi's tool loop keeps the only user entry at index 0, so every iteration replayed
the whole transcript. With an image in that first message the image branch
returned early and dropped every tool result, so the model never saw any tool
output and re-issued the same call indefinitely. Fixed upstream in
[pi-claude-cli#12](https://github.com/agustinsacco/pi-claude-cli/pull/12),
released as 0.4.6.

Two measurements shaped what Phosphor does about it:

- The Claude CLI's "Continue from where you left off" recovery nudge, which
  fires because break-early SIGKILLs the subprocess mid-turn, is a `<synthetic>`
  response with all-zero usage. It costs nothing and needed no fix.
- Comparing a livelocked session against a healthy one, redundant tool calls
  ran 24x for a single command when tool results were dropped, versus 7-of-52
  (13%, ordinary re-reads) when they got through. Break-early's missing
  assistant turns therefore carry no measurable penalty, so it was left alone.

## What changed here

**`src/lib/burnRate.ts`** — a pure assessment of a session's trailing token
stats. Two signals, because neither is trustworthy alone: billed tokens per
minute, and output tokens as a share of billed. Healthy minutes in the incident
data ran 27k–200k tokens/min at a few percent output; the runaway ran 1.4M–3.5M
at 0.28%. A large-context session doing genuine work trips the rate threshold
but not the yield one, so both must fire. Thresholds and their derivation are
documented in the module.

Samples are recorded in `refreshStats` (`src/stores/sessions.ts`), which already
polls `get_session_stats` on every completed sub-step of a turn, and dropped in
`disposeSession` alongside the other per-session slices.

**`ContextMeter`** grows a `N/min` badge beside the percentage when burn is
elevated or runaway, and an explanatory line in the popover naming the rate, the
output share, and the suggested action. Advisory only — it does not stop a turn.

**`StatusStrip`** no longer renders `phosphor-context-breakdown`. `setStatus` is
pi's only channel for pushing extension state to the front-end, so it doubles as
a data bus; the context-breakdown extension's JSON payload is meant for
`ContextMeter` to parse, but the strip was also printing it raw at the bottom of
the window. Structured keys are now excluded by name.

## Notes for later

The burn thresholds are calibrated against a single incident. If they prove
noisy, the yield signal is the one to trust — it separated the pathological
sessions from the healthy ones far more cleanly than rate did.

> **Superseded 2026-08-23.** That last sentence was wrong. Yield measures
> read-heaviness, not sickness, and a perfectly healthy session scored between
> two bad ones on it. The gate is now cacheWrite acceleration; see
> [The burn detector cried wolf](2026-08-23-burn-detector-cachewrite.md).
