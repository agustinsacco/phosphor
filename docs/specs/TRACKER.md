# Phosphor — Build Tracker

**How to use this file (executing agent, read this first):**

- Work phases in order. Each phase must end **runnable** (`npm run dev` launches, prior features still work) before its status flips to ✅.
- This file tracks the long-term plan only: the phase table, phase checklists, and each phase's own **Log**. Update it as you go — flip task checkboxes the moment a task is done, set phase status (⬜ todo → 🟡 in progress → ✅ done), add a dated note to a phase's Log when it completes or its plan changes.
- Work that isn't advancing a numbered phase (most day-to-day fixes and features) gets its own file: `log/YYYY-MM-DD-slug.md`, one dated write-up per change. Don't append it here — entries used to pile up at the end of this file, all landing at the same spot, so two PRs in flight at once conflicted here even when their code never overlapped. A new file per change has nothing to collide with.
- If you deviate from a spec, write the deviation + reason in the phase Log, or in the change's own `log/` file when it isn't phase work. Specs are the contract; this file is the state.
- Before implementing anything pi-related, re-read [02-pi-integration.md](../pi-integration.md) and verify against the local pi docs it lists.

| Phase | Title                                        | Status |
| ----- | -------------------------------------------- | ------ |
| P0–P9 | Foundations → tech-debt pass (archived)      | ✅     |
| P10   | Visual identity: Phosphor                    | ✅     |
| P11   | Chat UX correctness pass (Phase 0)           | 🟡     |
| P12   | UI refinements + platform features           | ✅     |
| P13   | Transcript density: activity grouping        | ✅     |
| P14   | Bedrock model availability + provider errors | ✅     |

Numbered phases stop at P14. Work since then lives in [log/](../log) as one
dated file per change — that is the current convention; do not open a P15
without a reason to batch work into a phase again.

**Still open** (the only unchecked boxes in this file, re-verified 2026-09-09):

- P11 — B6 cost honesty: per-component cost rows in the usage popover. The
  all-zero `ModelCost` half shipped as the "no pricing configured" text.
- P11 — phase 4: one hover-action component. Two implementations remain.
- P11 — phase 5: a `Notice` primitive for `RetryStrip`, `banners.tsx` and
  `RateLimitBanner` — three implementations, not the two recorded below.

Phases 2 and 3 were ticked in this pass: both had shipped by other routes and
nobody had reconciled the boxes.

---

## P0–P9 — Foundations through the tech-debt pass `✅`

All ten shipped. The per-phase detail, deviations and logs lived in
`specs/archive/TRACKER-P0-P9.md` until 2026-08-27, when `specs/archive/` was
deleted — nothing in it was a live contract and it was drifting unread. Recover
it from git if you ever need the archaeology:

```bash
git show 737f18e:specs/archive/TRACKER-P0-P9.md
```

---

## P10 — Visual identity: Phosphor `✅`

Specs: [style-guide.md](../style-guide.md). The execution plan
(`specs/archive/RESTYLE_PLAN.md`) was deleted 2026-08-27 now that the migration
it sequenced is done.

- [x] Brand definition: Phosphor system (amber-phosphor accent, paper/graphite neutrals, mono structural voice) with contrast ratios verified at design time
- [x] New mark ("prompt bubble") + `scripts/generate-icons.mjs` (Playwright-rendered png/icns/ico) + dev-run dock/window icon in `electron/main.ts`
- [x] RESTYLE_PLAN phases 1–3: token swap, xterm/Monaco, chart/mermaid (one PR)
- [x] Phase 4: mono structural-voice pass over labels/badges + serif retirement
- [x] Phase 5: sweep + e2e done. The "regenerate the screenshots" leftover was **closed by deleting them** on 2026-08-27 — see the log entry below.

**Done when:** zero terracotta hexes in `src/` + `electron/`, both themes swept manually. Both hold.

**Log:**

- 2026-08-07 — Brand adopted; guide + plan + icon landed on PR #4. Known dev-mode limitation documented in main.ts: macOS menu-bar title says "Electron" when unpackaged (Info.plist, not fixable at runtime); dock icon is set at runtime instead. Restyle deliberately deferred to its own PR — a half-migrated palette is the worst state.
- 2026-08-07 — Restyle phases 1–4 executed (see RESTYLE_PLAN Outcome): token swap + new `--px-terminal-bg`, xterm/Monaco/Mermaid/Chart.js re-themed, mono voice on all 18 uppercase-label sites, serif retired from chrome, heatmap info→accent. Exit grep clean; typecheck/lint/prettier/348 unit/8 e2e green; both-themes manual sweep in the browser harness (dark accent-text flip verified). Screenshots regen still pending.
- 2026-08-27 — **P10 closed.** The last box asked to regenerate
  `specs/screenshots/` because "the PNGs still show the pre-Phosphor UI". That
  was a misreading of what they were: every capture was of Anthropic's Claude
  Desktop, taken during the original cloning study, not of Phosphor. There was no
  Phosphor UI in them to regenerate, so the box could never have been ticked as
  written. Phosphor makes the resemblance an explicit non-goal
  ([style-guide.md](../style-guide.md): "the wrong place to stay"), so
  the 8.7MB of third-party captures were deleted and the two live docs that
  called them "the visual quality bar" were corrected. Phase 5's real work
  (sweep + e2e) had already landed on 2026-08-07.

---

## P11 — Chat UX correctness pass (Phase 0) `🟡`

Plan: `specs/archive/CHAT_UX_PHASE0_PLAN.md`, deleted 2026-08-27
(`git show 737f18e:specs/archive/CHAT_UX_PHASE0_PLAN.md`). Its still-relevant
phases are inlined at the bottom of this section so the open boxes stay
actionable without it.

- [x] B1 Streaming tool identity: `toolIdentity.ts` (placeholder ids, `toolName: null`, adoption on `tool_execution_*` / later partials) — no more "Running unknown", no more output routed to an orphan key
- [x] B2 Autoscroll: `items/autoscroll.ts` intent-based pinning + a synchronous pin ref + self-scroll suppression — reading back during a stream survives (e2e measures `scrollTop` holding while the stream grows the scroll range)
- [x] A3 **hypothesis refuted by measurement**: the virtualizer was innocent. With the old `estimateSize: 96` a 40-row harness run still measured 0.1px gaps — dynamic measurement corrects every mounted row. The 100px+ holes in the screenshots were spacing stacking (a tool row's wrapper was **63px for ~20px of text**: `pt-4` + `pb-0.5` + `my-2` + row `py-1`, four owners at once). `estimateSize` set to 40 to match measured reality, which affects scrollbar proportions only.
- [x] Phase 1 (pulled forward, since A3 made it the actual fix): `items/spacing.ts` is the single owner of vertical rhythm — one step (`pt-3`), one tight step for consecutive tool-only turns, no trailing padding; duplicate margins deleted from the tool group, `ThinkingBlock`, `DividerShell` and the expanded tool detail. Measured: tool row **63px → 33px (−48%)**, 40-tool transcript **2676px → 1468px (−45%)**, gaps still flush at 0.1px.
- [x] B3 Session title: `lib/sessionTitle.ts` shared by header + sidebar (pi never auto-titles)
- [x] B4 Floating right pane: `.pane-handle::after` transparent until hover/drag
- [x] B5 Pane scrolling: `PaneShell` content slot is a flex column, so `flex-1` bodies constrain their scrollers
- [x] Artifact tool UX: `ArtifactDetail` card (glyph/title/type/version, "Open in panel"), artifact-aware labels, live byte counter while content streams
- [x] Phase 2 — one type scale (delivered by the 2026-08-20 type-scale pass, without the proposed tokens)
- [x] Phase 3 — consecutive tool rows group by ink (delivered by P13's `ActivityGroup`)
- [ ] B6 Cost honesty: `—` for all-zero `ModelCost`, per-component cost rows in the usage popover. The "no pricing configured" half shipped; the per-component rows did not.
- [ ] Phase 4 — the two hover-action implementations in `MessageItem.tsx` are still separate
- [ ] Phase 5 — a `Notice` primitive for what is now **three** banner implementations

### Phases 2–5, inlined from the deleted plan

Recorded verbatim in intent so the boxes above survive the plan's deletion.
**Re-verified against the code 2026-09-09** — phases 2 and 3 had in fact been
delivered by other routes (the 2026-08-20 type scale, P13's activity grouping)
and their boxes are now ticked; 4 and 5 are genuinely open, and 5 is bigger
than the plan recorded.

| Phase | Intent                                                                                                                                     | Verified state (2026-09-09, read against the code)                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | One type scale replacing hardcoded sizes; larger body text in less vertical space. Plan proposed `--px-fs-*` tokens.                       | **Done, differently.** [The type scale](../log/2026-08-20-type-scale.md) replaced 424 sizes; the nine steps live as `@theme` entries in `src/styles/index.css`, not as `--px-fs-*`. Close it.       |
| 3     | Consecutive tool rows of one turn render as one block (gray label + emphasized object), grouping by ink rather than whitespace.            | **Done.** P13's `items/ActivityGroup.tsx` + `items/transcriptRows.ts`, virtualized from `MessageList.tsx`. Close it.                                                                                |
| 4     | One `MessageActions` used by both user and assistant messages, always rendered, so turn rhythm stops alternating. Plus B3 session title.   | **Open, and deliberately so.** B3 is done. `MessageActions` was never built — P13 shipped a zero-height floating hover pill instead, which is the better answer to the same problem. Two hover      |
|       |                                                                                                                                            | implementations remain in `MessageItem.tsx`. Unify them or drop the box; do not build the plan's version.                                                                                           |
| 5     | A `<Notice tone level actions>` primitive replacing `CrashBanner` / `NoModelsBanner` / `RetryStrip` / the inline assistant error. Plus B6. | **Open, and larger than written.** There are now **three** separate implementations, not two: `RetryStrip.tsx`, `banners.tsx` and `composer/RateLimitBanner.tsx`. B6's "no pricing configured" text |
|       |                                                                                                                                            | exists in `ContextMeter`; the per-component cost rows do not.                                                                                                                                       |

**Done when:** the plan's Phase 0 exit criteria hold in e2e and Phases 1–5 are either landed or explicitly deferred here.

**Log:**

- 2026-08-08 — Phase 0 landed. Evidence: 409 unit tests (30 files) + 11 e2e green. The transcript e2e asserts unpin-survives-stream, zero "unknown" tool labels, and **row density** (tallest tool row < 44px, gaps < 8px) — verified non-vacuous by restoring a single duplicate margin, which pushes the row to 48.9px and fails the test. The artifacts e2e asserts the pane's scroller actually overflows and scrolls. B6 verified as _correct_ rather than fixed — pi prices cacheRead/cacheWrite separately and Phosphor only displays its numbers (arithmetic checked against a live session: 50/14.9k/706k/115k tokens at $5/$25/$0.50/$6.25 per 1M = $1.4445 vs $1.4410 displayed, the delta being token-display rounding). Remaining B6 work is display honesty for models with no pricing configured, not a math fix.
- 2026-08-08 — Method note: the A3 "virtualizer estimate causes the gaps" hypothesis was **refuted** by the measurement it was gated behind (0.1px gaps at the old estimate). Restyling margins first would have "fixed" the symptom for the wrong reason. The plan's Phase 0 gate earned its place; keep gating layout hypotheses on a harness measurement.
- 2026-08-08 — Process note: two agent sessions edited this tree concurrently; one committed `1e55008` and discarded the rest of the working tree, destroying unrelated uncommitted work (a WorkingIndicator component, an extracted `items/spacing.ts`, model-catalogue changes). Untracked files were unrecoverable. Checkpoint-commit before parallel work on the same tree.
- 2026-08-09 — Adversarial review pass over the whole branch (7 reviewers + per-finding refutation): 40 findings raised, 1 refuted, 4 downgraded. Fixed here, each with a regression test: `artifact_update` cards rendering the sentinel type `update` (wrong glyph) and the slug id as title (store metadata now wins); `partialStringArg` mangling `\uXXXX`/`\r`/`\b`/`\f` escapes ("Café"→"Cafu00e9") — now decodes the full JSON escape set and bails on unknown ones; the placeholder tools-map entry leaking on the ordering real pi actually produces (`message_end` before `tool_execution_*` — the unit suite only covered the inverse, which pi never emits); `toolcall_end` duplicating the re-key mechanics of `applyRevealedIdentity` (now one owner); tool cards remounting on identity adoption (keyed by position, not the mutable id); the thinking chip misreporting after a model switch (pi re-clamps during `set_model`; state is re-read) and offering the previous model's levels (cleared synchronously so the local derivation covers the gap); the thinking menu duplicated between both pickers (extracted `ThinkingMenu`); `sessionTitle` bypassed by the palette and tree modal; astral characters split at the elision boundary; scrollbar-drag and wheel-down-at-bottom not registering as intent; unpin stranding a non-overflowing transcript; sending a message not re-pinning; the jump pill labelling state instead of its action; `isToolOnlyTurn` reflowing the row 8px at `text_end`; the artifacts viewer yanking a reader off a pinned older version. Also restored the two features destroyed by the concurrent-session incident above (WorkingIndicator + the model-catalogue RPC rework), the latter now carrying `thinkingLevelMap` so the home picker derives real per-model levels instead of assuming five. **Two e2e assertions were proven vacuous by reintroducing the bugs they guard**: the "unknown" check passed with `Running unknown` restored (point-in-time count-0 against a window a few ticks wide) — now a MutationObserver over the whole stream, re-verified to fail when the bug returns. Evidence: 423 unit (32 files) + 11 e2e green.

## P12 — UI refinements + platform features (10-item pass) `✅`

Specs: [WORKTREES.md](../worktrees.md) · [11-mcp.md](../mcp.md)

- [x] Removed the informational "Local" chip from the home composer
- [x] ANSI-safe extension UI: `src/lib/ansi.ts` (stripAnsi + ansiToSpans); status strip and composer widgets render SGR colors, toasts/dialogs strip — fixes raw `[38;2;…m` bytes in the bottom bar
- [x] pi protocol mirror refreshed to **0.84.1** (`MIN_PI_VERSION` bumped): delta-only `message_update` (no cumulative `message`/`partial`), `agent_settled`/`bash_execution_update`/`summarization_retry_*` events, `get_available_thinking_levels`/`get_entries`/`get_tree` commands mirrored, ThinkingLevel `max`; dead partial-read removed from the chat reducer; thinking levels now fetched over RPC
- [x] Transcript redesign: consecutive thinking+tool blocks group into one activity unit (`items/ActivityGroup.tsx` + reshaped `groupBlocks`) — expanded card while live, collapsed one-line summary when settled; hover meta became a zero-height floating pill (copy + time, **per-message cost removed**); `spacingFor` tightened (~40px → ~14px between messages)
- [x] Sidebar: PiSpark while streaming, green pill = persisted **unseen activity** (`seenSessions` pref + `app:markSessionSeen`, pure `unseen.ts`), hollow-green = live-but-seen; compact rows; subtitle = time · wt · ⎇ branch · ±dirty · cost via batched cached `git:infoBatch` (GitInfo gained `isWorktree`/`mainRepoPath`)
- [x] Terminals re-keyed **per session** (spawned in the session cwd); PTYs killed on session dispose (artifacts cleanup gap fixed too); foreground-process busy detection (`IPty.process` polling → `pty:status`); terminal + artifacts header buttons gained count badges and running dots
- [x] Usage: scanner splits token classes; `sessions:usage` rollup across every session dir grouped by header cwd; Usage modal (sidebar nav) with sortable per-workspace/session table; `formatCost`; ContextMeter popover sectioned, shows "no pricing configured" (models.json rates) instead of a misleading $0.0000
- [x] Worktrees full lifecycle under `<repo>/.phosphor/worktrees/` — see WORKTREES.md
- [x] MCP first-class: Settings → MCP over the pi-mcp-adapter config chain — see 11-mcp.md

**Done when:** all ten user-reported items addressed; typecheck/lint/prettier/unit/e2e green.

**Log:**

- 2026-08-10 — All ten items landed in one pass. Verification: typecheck, lint, prettier, 415+ unit tests, 12 e2e (3 new: usage view, worktree flow, MCP settings). UX_REFACTOR_PLAN item C6 (worktree chip) is now implemented by `BranchWorktreeChip`. Deviations from the approved plan: terminal scrollback preserved by keeping all sessions' xterm views mounted (existing idiom) instead of a main-process ring buffer + `pty:buffer` IPC; MCP raw file editing uses a plain textarea escape hatch instead of refactoring the Monaco `ConfigFileEditor`.

---

## P13 — Transcript density: turn-level activity grouping `✅`

Design review artifact: four options measured against real session files
(`~/.pi/agent/sessions`), 356 assistant messages analysed.

**The finding that drove it:** pi emits ONE assistant message per tool call
(302 of 356 messages carried exactly one). P11's grouping worked only _inside_
a single message, so it could never collapse a run — every call became its own
top-level row paying full inter-message spacing. Runs are commonly 3 deep and
go to 18. That is why "Thought · Ran …" repeated down the page instead of
stacking, and why framed and bare rows alternated.

- [x] **A · turn-level spine** — new `items/transcriptRows.ts`
      (`buildTranscriptRows`) groups activity ACROSS message boundaries: a
      contiguous run of thinking + tool calls is one row regardless of how many
      messages produced it. Prose, user, bash and dividers stay their own rows,
      so ordering is preserved. `MessageList` now virtualizes over
      `TranscriptRow[]` rather than raw items. Measured on a real 22-tool turn:
      **1135px → 274px (4.1× tighter)**.
- [x] **B · thinking demoted to the gutter** — thinking never occupies a row.
      It becomes a `✳` mark in the left gutter of the step it preceded; hover or
      focus previews, click pins. Zero vertical cost until asked for (median
      thinking is 337 chars, p90 1.6k — a preview, not a document).
- [x] **D · live vs settled** — a group with work in flight is open and
      accent-bordered; once settled it auto-collapses to the summary line. An
      explicit user toggle always wins, and is reset if the group goes live again.
- [x] Collapsed head is verb-counted (`summarizeActivity` + new `settledVerb`),
      not a list: "9 steps · edited 5 files, ran 2 commands · 1 thought". Counting
      is what keeps an 18-deep run to one line. Failures surface as an
      "N failed" badge.
- [x] "Running unknown" is fixed by P11's `toolIdentity.ts` (`toolName: null` +
      adoption), which landed independently on main and is the better fix; the
      stopgap from this branch was dropped during the rebase.
- [x] `items/groupBlocks.ts` deleted (superseded); `AssistantMessage` split into
      `AssistantText` + `AssistantOutcome` row renderers.

**Done when:** a multi-tool run reads as one collapsible unit; typecheck, lint,
prettier, unit and e2e green.

**Log:**

- 2026-08-10 — Landed with 16 new unit tests for the grouping layer (including
  a regression test that a 4-message tool run produces ONE activity row) and
  e2e assertions for the collapsed summary, single-group invariant, live-open →
  settled-collapsed transition, and absence of placeholder tool names. Also
  hardened the MCP e2e test with its own prefs dir: project-scope writes target
  the active workspace, and a `lastSessionPath` left by an earlier test could
  restore a different one (observed as a one-off flake).

**Rebase onto P11 (#5), 2026-08-10.** #5 independently diagnosed the same root
cause (`isToolOnlyTurn` — "pi emits a fresh message per tool round") and treated
it with tight spacing; this branch treats it structurally, so the two had to be
reconciled rather than merged mechanically. Decisions:

- Kept #5 wholesale where it is strictly better: `toolIdentity.ts` (nullable
  `toolName`, placeholder adoption — supersedes this branch's `'unknown'`
  stopgap AND restores the `partial` read this branch had deleted as dead),
  `items/autoscroll.ts` intent-based pinning, the awaited-`get_state` fix for
  the relaunch race, and the richer `shared/rpc.ts` mirror comments.
- Rewrote `items/spacing.ts` for rows and deleted `isToolOnlyTurn`: consecutive
  tool-only messages no longer need a spacing special case, because they merge
  into one activity row before spacing is consulted. Its test file moved to the
  row API with the same intent.
- `ActivityGroup` now threads `sessionId` to `ToolCard` (#5 needs it for
  artifact actions) and tolerates `toolName: null` in the verb summary.
- Caught by the rebase: `settledVerb` had no `artifact_create`/`artifact_update`
  case, so an artifact turn summarized as "used 1 tool" instead of "created 1
  artifact" — #5's artifact-identity work is what made this visible. Fixed with
  a regression test.
- Also caught by the rebase, in this branch's own code: marking the _active_
  session seen on every `message_end` wrote to prefs on every token-batch, and
  that write raced `setLastSession` during teardown — a session closed right
  after a reply lost its resume path, so the next launch landed on the
  workspace home with an empty session list. Removed (it was redundant:
  `activate` / `bootstrapSession` already mark seen, and the pill only
  describes sessions you are not looking at). The multi-workspace sidebar e2e
  is what caught it; bisected by reverting that single line.
- e2e: kept #5's working-strip assertion and merged both MutationObserver
  probes into one; rewrote "transcript rows are dense" as "a long tool run
  collapses to one dense group" — 40 tool-only turns are now ONE row, so the
  density assertion moved from per-virtualized-row to per-tool-card, plus a new
  collapsed-height check.

## P14 — Bedrock model availability + actionable provider errors `✅`

**2026-08-10.** Triggered by two real Bedrock failures in a live session, both
of which rendered as opaque red walls with no path forward:

1. `Invocation of model ID anthropic.claude-fable-5 with on-demand throughput
isn't supported.` — the bare foundation id was selected from the model menu.
2. `data retention mode 'default' is not available for this model` — an
   account-level Bedrock setting that Claude 5 models refuse to run under.

Neither is a Phosphor or pi bug; pi surfaces exactly what Bedrock returned (the
docs-URL suffix on #2 is pi's own courtesy hint, added in
`pi-ai/api/bedrock-converse-stream.ts`). What _was_ a Phosphor bug: the menu
offered a model that fails 100% of the time, and the errors taught nothing.

- [x] **A · the bare id is no longer selectable** — new
      `lib/modelAvailability.ts` infers uninvocability from the catalogue's own
      shape: a bare Bedrock id is unusable when region-prefixed siblings
      (`us.`/`eu.`/`global.`/…) of the same foundation model are also offered.
      Deliberately NOT a hardcoded capability table — that data belongs to pi's
      model store and would drift the moment AWS changes a model's
      requirements. Flagged rows render dimmed, unclickable, and skipped by
      ↑/↓/Enter, with the reason on a second line. They stay _visible_ rather
      than hidden so searching "fable" still explains where Fable went.
      `MenuRow` grew a `disabled` prop for this.
- [x] **B · errors carry the fix, not just the failure** — `errorRemedies.ts`
      gained the two Bedrock cases. `ErrorRemedy.command` is now optional:
      the retention failure has no shell fix, so it renders a docs link plus a
      pointer at the model picker instead of a fabricated command. Both new
      cases are ordered ahead of the generic OAuth/401 rule, which the
      retention message would otherwise trip.
- [x] **C · the browser-only harness actually boots again** — `npx vite dev`
      is documented in CLAUDE.md but bare `vite` picks up nothing from
      `electron.vite.config.ts`, so `@/` and `@shared/` went unresolved and the
      app failed to load (the `web-mock` launch entry was dead). Added a
      renderer-only `vite.config.ts`; keep its root/aliases in sync with the
      `renderer` section of the electron config. `mockPhosphor` now serves
      Bedrock-shaped models so the harness exercises the disabled-row path.

Coverage: 27 new unit tests (`modelAvailability`, `ModelMenu` DOM incl. keyboard
traversal over disabled rows, `ErrorBlock` DOM incl. "no command for the
retention failure"). Verified in the mock harness in both light and dark themes.

**Still outstanding (not Phosphor's to fix):** the retention mode itself. A Bedrock
admin has to move the account off `default`; until then every Claude 5 call
fails regardless of inference profile. Which AWS account serves these calls was
not confirmed — `~/.aws/config` has three SSO profiles (`dev`, `domains`,
`prod`) and none was active during triage.
