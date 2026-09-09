# The context meter stops charging Claude's prompt to pi's

## Symptom

A Claude Opus 5 session opened its popover on turn 1 and read
**System prompt 51.1k** against a total of 95.5k. The pi system prompt that
session was sent is 40,772 characters — **~10.2k tokens**. The slice then kept
moving turn to turn, though nothing in the prompt changed.

## Cause

`breakdownSlices` scaled every measured component onto pi's total:

```
scale = piTotal / (messages + systemPrompt + tools + mcpTools)
```

so the slices summed to the total **by construction** (51.1 + 40.8 + 3.6 =
95.5k in that screenshot). That is only correct if pi can see the whole
request. It cannot. `pi-ext/context-breakdown.ts` measures pi's own state; the
Claude CLI additionally sends its own system prompt and its own native tool
schemas, and keeps native tool results in its own transcript. Everything pi
could not see was therefore multiplied onto the rows it could.

## Measurement

Two live sessions, 2026-09-09, same repo and the same pi tool registry.
Recomputed the published formula per turn from each session's JSONL.

|                              | native pi (`openrouter/inkling`, `01a08669`) | Claude (`claude-opus-5`, `01a0865a`) |
| ---------------------------- | -------------------------------------------- | ------------------------------------ |
| pi system prompt, measured   | 9,903 tok                                    | 9,914 tok                            |
| scale factor across turns    | 1.02 – 1.08                                  | 2.27 – 4.45                          |
| "System prompt" as displayed | 9.9k – 10.7k                                 | 22.5k – 44.1k                        |

The native session stayed within ~8%; pi sees everything there. The Claude
session's first Claude API call cost **39,690 input tokens** by the CLI's own
transcript, against the **10,163-token** prompt pi supplied — so **~29k** of
that request was never pi's to attribute. (pi measures its prompt _before_ the
provider aligns it: 9,914 measured, 10,163 sent.)

## Fix

Estimates now scale **down** to fit pi's total and never up — a component
cannot outweigh the whole request, but neither may it absorb someone else's
context. The remainder becomes its own `unmeasured` slice, with a hint naming
what it is. `mcpServerRows` uses the same rule so the chips still agree with
the bar.

On the same Claude data the system prompt now reads a flat 9,914 on all four
turns, and the legend still sums to pi's total exactly — the regression test
asserts both. Native sessions gain a small Unmeasured slice (~500 tok, the
gap between `chars / 4` and a real tokenizer), which is honest.

Nothing about pi's total changed: it remains the authoritative number, and it
still decides compaction.

## Not in scope

This does not make Claude's own prompt or tool schemas measurable — it stops
mislabelling them. Doing better needs a size the CLI does not report.
