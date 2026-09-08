# The burn detector cried wolf: yield out, cacheWrite acceleration in

2026-08-23

## What happened

The runaway-burn warning shipped on 2026-08-22 fired on a session that was
working perfectly.

Session `01a02c8e` was asked to read the twelve largest `.tsx` files in the
repo. It read twelve files in thirteen model calls and stopped. Replaying its
real timeline through the shipped detector, it goes `elevated` at t+65s and
stays there for the rest of the session. Nothing was wrong with it.

That is the worst failure mode available to a warning of this kind. The whole
point of the badge is that a runaway is invisible in the context percentage, so
the badge is the only signal — and a badge that lights up on ordinary
file-reading is one the user learns to ignore within a day.

## Why yield was never a discriminator

The shipped detector ANDed two signals: billed tokens per minute above a
threshold, and _yield_ (output tokens as a share of billed) below 2%. The
2026-08-22 note closed with "if they prove noisy, the yield signal is the one to
trust — it separated the pathological sessions from the healthy ones far more
cleanly than rate did."

That was wrong, and it was wrong because it was calibrated on one incident where
every low-yield session happened to be sick. Measured across three real sessions
on this machine:

| session    | yield | reality                                             |
| ---------- | ----- | --------------------------------------------------- |
| `01a02bb0` | 0.50% | genuine runaway; the resume prompt grew 51x         |
| `01a024eb` | 1.15% | 10-hour mixed session, real work plus some replay   |
| `01a02c8e` | 0.93% | completely healthy: 12 large files read in 13 calls |

The healthy session's yield sits **between** the two bad ones. There is no
threshold that separates them, because yield is not measuring what we thought.
Yield is low whenever a session reads more than it writes — which describes a
replay loop and equally describes any competent agent doing research. It
measures read-heaviness, not sickness.

## Why cacheWrite acceleration works

The replacement gate compares the rate at which `cacheWrite` accumulates in the
second half of the trailing window against the same rate in the first half.

The mechanism is the reason to trust it. A replay loop re-sends context it has
already delivered, so the prompt _prefix_ is different on every turn, the cache
misses, and the whole prefix is written again — and the amount written grows,
because the transcript being replayed keeps growing. Healthy accumulation
appends to a prefix that is already cached, so cacheWrite per turn falls toward
the size of the newly added content alone.

So the ratio is not a correlation someone noticed in a log. It is a direct
reading of whether the session's cache prefix is stable, which is the definition
of the pathology.

Measured over 90s windows that already cleared the 400k tokens/min gate:

| session    | median accel | max accel |
| ---------- | ------------ | --------- |
| `01a02bb0` | 3.82         | 4.34      |
| `01a024eb` | 0.57         | 10.55     |
| `01a02c8e` | 0.62         | 0.66      |

The mixed session's spread is the correct answer, not noise: it fires during its
bad stretches and not during its good ones.

Resampling both clean timelines at seven polling densities (one sample per model
call up to thirteen) and evaluating every prefix, no healthy window that cleared
the rate gate exceeded **0.91**, and no runaway window came in under **2.86**.
The threshold is 1.5 — just below the geometric middle of that gap (1.61),
biased toward missing a slow loop rather than crying wolf on real work.

Both rate thresholds are unchanged at 400k / 1M tokens per minute. Lowering them
was considered and rejected: the healthy session already clears 400k, so a lower
rate gate makes the false positive worse, not better.

## What changed

**`src/lib/burnRate.ts`** — `BurnSample` grows a cumulative `cacheWrite`
counter. `assessBurn` computes the acceleration and gates `level` on it.
`yield` is still returned and still shown in the popover, because it is useful
context once you already know something is wrong; it just decides nothing.

The window is split by **time**, not by sample index. `get_session_stats` polls
on every completed sub-step, far more often than model calls, so runs of
consecutive samples carry identical counters. A duplicate moves the midpoint's
index but not its timestamp, so a time split is invariant to how fast the app
happens to be polling — verified at densities from 1 to 13 samples per gap.

A window whose first half wrote no cache at all yields no ratio (0/0, or a
division by zero) and reports `null`, which does not fire. A burst that starts
mid-window lands in exactly that case; the cost is one more poll, after which
both halves contain a call.

**`src/stores/sessions.ts`** — `refreshStats` passes the `cacheWrite` it was
already destructuring into `recordBurnSample`.

**`ContextMeter`** — the popover explained the warning in terms of output share.
It now names the acceleration and what it implies, and reports yield as
secondary context.

**`src/lib/burnRate.test.ts`** — both real timelines are baked in as literal
arrays of real measurements, extracted from `.message.usage` in pi's own
transcripts. The healthy one is asserted across _every prefix_, not just its
final state, because the regression was a mid-session false positive that a
final-state assertion would have missed entirely. Polling duplicates are
interleaved at four densities and the verdicts must not move.

## The honest caveat

This is calibrated on exactly one clean runaway and one clean healthy session,
plus one mixed session used as a sanity check. That is more evidence than the
yield gate had, and it is still not much. The gap between 0.91 and 2.86 is wide
enough that 1.5 is unlikely to be badly wrong, but the threshold should be
revisited as more sessions accumulate — particularly from providers other than
Claude Code, whose caching behaviour Phosphor has not measured at all.

One known blind spot, stated plainly: acceleration detects a loop whose cost is
_compounding_. A loop that replays a constant-size prefix at a constant rate
sits at an acceleration near 1.0 and will not fire. That is a deliberate
trade — a bounded-cost loop is the less dangerous one, and covering it would
mean giving back the false-positive immunity this change was made to get.

The lesson worth keeping is smaller than the fix: the previous note's confidence
in yield came from a single incident in which the confound (read-heaviness) was
perfectly correlated with the disease. One incident cannot tell those apart. It
took a healthy session that looked identical on the chosen metric to show it.
