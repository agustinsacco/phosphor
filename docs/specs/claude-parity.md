# Claude Code / native pi transcript parity

**Status:** proposed, 2026-09-06. Nothing here is shipped.

**Goal.** A turn on the Claude Code provider (`@saccolabs/pi-claude-cli`) reads
exactly like a turn on a pi-native provider. Same summary vocabulary, same row
anatomy, same expandable detail, same failure signal. One deliberate
difference survives: the `cc` provenance mark in the row gutter.

The renderings of the target state are in the artifact that accompanies this
doc.

## Why the two diverged

Every divergence traces to one fact: **the provider forwarded the tool call and
not the tool result.** `items/transcriptRows.ts` and `items/ActivityGroup.tsx`
were built to be honest about that — no chevron, because there is nothing to
expand into; no status, because the marker carries none. That was correct when
it was written and is no longer correct: `pi-claude-cli` 0.7.0 already ships
result forwarding behind a host opt-in, and Phosphor never turned it on.

## The divergences, with their evidence

| #   | Today, Claude Code                           | Today, native pi                               | Cause                                                                                                                                                                                   |
| --- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `5 steps · claude code 5 tools`              | `27 steps · ran 13 commands · 14 thoughts`     | `summarizeActivity` buckets every `externalTool` step under one `'Claude Code'` label (`transcriptRows.ts:640`), so the verb vocabulary the rows already use is thrown away in the head |
| D2  | No chevron, no detail                        | Chevron on every row, per-tool detail view     | Provider sends no `tool_result` unless `PI_CLAUDE_CLI_TOOL_RESULTS=1` (`event-bridge.ts:704`); Phosphor does not set it (`electron/pi/provider-detect.ts`)                              |
| D3  | No `failed` badge, no `N failed` on the head | Red row, `failed` chip, `2 failed` on the head | Same cause as D2. `summarizeActivity` only counts `tool.status === 'error'`, which external steps can never reach                                                                       |
| D4  | `Created tab…` — a label cut mid-path        | Full path                                      | Provider caps the argument preview at 120 chars (`event-bridge.ts:687`)                                                                                                                 |
| D5  | `cc` mark in the gutter                      | no mark                                        | Deliberate. Recommend keeping it                                                                                                                                                        |

Two things that look like divergences and are not:

- **The two-line model chip** (`Claude Opus 5` over `via pi-claude-cli`) was
  fixed in [#206](https://github.com/agustinsacco/Phosphor/pull/206). Screenshots
  older than 2026-09-06 still show it.
- **The bottom status strip** (`192 tools · MCP: 4 servers enabled`) is MCP
  configuration, not provider behaviour.

One thing that needs measuring before it can be planned: a live Claude turn
showed `0 tokens` on the working indicator and `0%` on the context meter after
six minutes. The provider recomputes usage on every `message_delta`
(`event-bridge.ts:651`), so the figure exists upstream. Where it is lost is not
yet known. Phase 0 finds out.

## Plan

Four phases. Each is its own PR. Phases 1 and 2 are independent of each other.

### Phase 0 — measure the token/context gap

Run one real Claude turn and one native turn side by side, capture
`stats.tokens.total` and the meter percentage at three points in each. Decide
whether the loss is in the provider, in `hasUsageDeltas`, or in
`shouldRefreshStatsOn`. No code change. Output: a finding appended here.

### Phase 1 — one vocabulary in the summary head (fixes D1)

`summarizeActivity` takes the external step's own verb instead of a fixed
bucket. `summarizeExternalTool(name, fields).label` already returns `Ran`,
`Read`, `Edited`, `Searched for` — the same words `settledVerb` gives pi's
tools. Bucket by that label and the existing `NOUNS` table does the rest:
a Claude turn reads `27 steps · ran 13 commands, read 4 files`.

- `Searched for` normalises to the `Searched` bucket; `Found files matching` to
  `Found`; `Used` keeps its `tool/tools` nouns for unrecognised MCP tools.
- Drop the `'Claude Code'` entry from `NOUNS`.
- Sub-agents keep their own `Launched` bucket. Unchanged.

Verify: extend `items/activityGroupRows.test.tsx` with a mixed run (pi tools
and external tools in one group) asserting one merged detail string; replay the
47-marker fixture in `items/externalToolRealMarkers.test.ts` and assert the
head names commands, not `claude code N tools`.

### Phase 2 — results, status and detail (fixes D2, D3, D4)

1. **Set `PI_CLAUDE_CLI_TOOL_RESULTS: '1'`** in `claudeProviderSpawnEnv()`
   (`electron/pi/provider-detect.ts`). No version check: the file's existing
   pattern is an env var that older providers simply ignore, and this one is
   the same. It needs `>= 0.7.0`, which goes in `CLAUDE.md`'s version ladder
   alongside the other four.
2. **Teach the marker parser the two new shapes.** This must land in the same
   commit as step 1, or worse than nothing happens: the current regex captures
   `#<toolUseId> {json}` into `args`, so `externalToolInfo` reads the id as an
   argument and every row loses its label.
   - `[Claude Code · <Name> #<id> <argsPreview>]` → `ExternalToolBlock` gains
     `toolUseId`.
   - `[Claude Code · result #<id> <payloadJson>]` → a new marker kind. The
     payload is **complete** JSON (`{status, preview, length, truncated?}`) and
     may be parsed, unlike the args preview which may not.
3. **Fold results onto their calls in `buildTranscriptRows`**, by `toolUseId`,
   the same way sub-agent markers already fold by `task_id`. A call with no
   result stays exactly as it renders today — sessions recorded before this
   ships are on disk forever and must keep working.
4. **Give the row the rest of the anatomy** in `ExternalToolRow`: chevron when a
   result exists, `failed` chip and danger ink when `status === 'error'`, and a
   detail pane rendering `preview` (with a "truncated at 2000 characters" note
   when `truncated`). `summarizeActivity` counts an errored external step in
   `failedCount`, so the head gets its `N failed` badge.
5. **Raise the argument preview cap** in the provider from 120 to 512 when
   result forwarding is on, and cut it on a character boundary. Provider PR,
   published and reinstalled before this is claimed done.

Verify: new fixtures in `chat/__fixtures__/` captured from a real turn with the
flag on; `items/claudeCliRendering.test.ts` gains an ok-result case, an
error-result case, and a call-with-no-result case.

### Phase 3 — the docs that go stale

`docs/chat.md` (the Claude-provider block table), `docs/extensions.md` (the
"How provider transcripts render" section — its "two things are deliberately
NOT borrowed" paragraph becomes wrong) and `CLAUDE.md`'s provider-version
ladder. Same PR as Phase 2, not a follow-up.

## The one difference that stays

Keep the `cc` gutter mark. It reserves no column (`GUTTER_MARK` is
`absolute`), so it costs the shared row inset nothing, and it answers a
question nothing else can: pi never saw these calls, so they are absent from
its own tool accounting. Everything else about the row becomes identical.

If the mark should go too, that is a one-line deletion in `ExternalToolRow` and
a test update — say so and it goes.
