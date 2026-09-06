# pidex engineering workbench review

**Assessment and proposal, not shipped behavior.** Reviewed 2026-09-05 at
`ae57ae3d4ac826da83585815419109a7c2b23801`. Priorities are design judgments;
observations, code-traced risks, and untested hypotheses are distinguished below.
No application behavior changes accompany this review. Follow-through:
[typography, session polish and richer input](session-polish-pr-2026-09-05.md#implementation-and-evidence)
are implemented in open PRs #194–#199; the broader workbench remains proposed.

## Recommendation

**Evolve from a conversation-centered agent IDE into an evidence-centered
engineering workbench.** Keep chat as the universal input and inspectable history;
make the work, decisions, and verification the primary navigation objects.

pidex already has much of the foundation: independent worktree lanes, a Home lane
board and cost ledger, multi-provider model switching, Claude account routing,
rich grouped transcripts, per-session pane layouts, versioned artifacts, session
trees, and a Skills library. Do not pitch those as missing features. The opportunity
is to connect them into a legible path from intent to reviewed delivery.

The working hypothesis is that more capable agents shift the bottleneck toward
human review and context switching. This review does not establish that hypothesis
through customer research or production telemetry.

## Visual and interaction assessment

For specific font delivery, type sizes, density, surfaces and interaction rules,
see the [Phosphor refinement proposal](phosphor-refinement-2026-09-05.md).

- **Keep Phosphor.** Warm graphite/amber dark, cool-neutral/ember light, restrained
  borders and structural monospace are distinctive. This needs stronger hierarchy,
  not a new palette, glowing dashboards, or a wholesale VS Code imitation.
- **Promote meaning above metadata.** Lane title and next action should dominate;
  branch/path/cost belong in a quieter secondary row. Label important pane switches
  at comfortable widths; retain compact icons with accessible names at narrow widths.
- **Increase readable density, not information density.** Essential status currently
  uses small, low-contrast tertiary text. Token calculations give 2.74:1 for light
  tertiary/page, 3.77:1 for dark tertiary/page, and 2.99:1 for dark tertiary/raised.
  These are below the normal-text 4.5:1 threshold. Use secondary ink for meaningful
  labels; keep tertiary for genuinely decorative content. White/dark-danger is
  3.07:1; short bold button copy alone is not a WCAG exception.
- **Design for the laptop layout.** At a 1000×740 window, the fixed sidebar plus
  chat plus Files/explorer leaves a cramped editor. No body overflow was observed;
  the problem is useful reading space. Offer Focus / Review / Debug layout presets,
  a collapsible explorer, and contextual switching instead of another permanent column.
- **Strengthen first-run guidance.** The empty Home is calm but leaves a large gap
  between its greeting and bottom composer. Offer optional task starters, visible
  provider readiness, and an explicit checkout destination. Experienced users should
  still be one prompt away from work.
- **Repair keyboard semantics before adding chrome.** Global focus rings and
  depth-aware Escape already exist. They do not substitute for modal focus
  containment, dialog semantics, labeled icon controls, and keyboard-operable rows.

Authority: [style guide](../../style-guide.md),
[tokens](../../../src/styles/index.css),
[TopBar](../../../src/app/TopBar.tsx),
[Modal](../../../src/components/Modal.tsx),
[Settings](../../../src/features/settings/SettingsModal.tsx).

## Open findings

“Open” means unresolved at the reviewed snapshot, not that every consequence has
been reproduced in production. P1 = trust/recovery; P2 = usability/coherence.

| ID  | Priority | Status | Evidence and user consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Targeted next step                                                                                                                                                                                           |
| --- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | P1       | open   | **Code + browser function probe:** `classifyLane` returns ready/merge for an open, conflicting PR with green checks and `REVIEW_REQUIRED`; `prChip` reports conflict for the same input. With checks absent, the board still says “checks green.” [Classifier:82–138](../../../src/features/home/laneState.ts#L82), [chip:83–92](../../../src/features/sessions/prChip.ts#L83).                                                                                                                       | Share readiness semantics; distinguish no CI, pending review, conflict, and stale local work. Do not require CI where none exists.                                                                           |
| R2  | P1       | open   | **Code:** board Merge opens a local `--no-ff` merge into the main checkout's current branch, not a GitHub PR merge. The modal explains this and has dirty/conflict guards. [Board:114](../../../src/features/home/LaneBoard.tsx#L114), [modal:143](../../../src/features/worktrees/MergeWorktreeModal.tsx#L143).                                                                                                                                                                                      | Name the exact source and destination; distinguish “Merge locally” from “Open PR.” Preserve existing safeguards.                                                                                             |
| R3  | P1       | open   | **Code:** Changes inventories only completed native `edit`/`write` calls; every write is marked created, and counts accumulate operations rather than net changes. Shell/provider-internal edits, deletions and renames have no independent discovery path here. [Collector:23–62](../../../src/features/files/collectTouchedFiles.ts#L23).                                                                                                                                                           | Git/baseline-backed inventory and net diff, with tool attribution overlaid separately. “Changed during session” is not proof of authorship.                                                                  |
| R4  | P1       | open   | **Code-traced safety risk; no data-loss reproduction:** baselines are transient and recaptured on reopen. Capture may fall back to HEAD. `showFileAt` returns null on any Git error; restore treats null as confirmed absence and trashes the file. Non-Git write fallback can also trash an overwritten file. [Store:665–669](../../../src/stores/sessions.ts#L665), [Git:52–118](../../../electron/fs/git-service.ts#L52), [revert:113–127](../../../src/features/files/FilesChangedPane.tsx#L113). | Durable retained baseline references; separate missing file from failed lookup; fail closed on ambiguous restore; preserve recovery bytes. Test expired refs, non-Git overwrites and intervening user edits. |
| R5  | P1       | open   | **Code:** failed worktree creation warns, then starts the prompt in the original checkout. This is intentional fallback policy, but changes the isolation the user selected. [startChat:109–117](../../../src/features/sessions/startChat.ts#L109).                                                                                                                                                                                                                                                   | Preserve the draft and offer Retry / Continue here / Cancel before session launch. This is a launch-location decision, not a new tool permission system.                                                     |
| R6  | P2       | open   | **Observed:** clicking Skills on empty Home leaves Home visible with no pane. Layout requires an active session; the visible navigation does not communicate that. [Sidebar:705–712](../../../src/features/sessions/Sidebar.tsx#L705), [layout:166–168](../../../src/stores/layout.ts#L166).                                                                                                                                                                                                          | Make Skills/Artifacts workspace-level destinations, including empty and loading states, without starting a model.                                                                                            |
| R7  | P2       | open   | **Observed:** Changes file row is a div, no role, tabIndex −1. Settings has no dialog/aria-modal semantics; Tab escaped the overlay in the browser harness, while Escape closed it. [FilesChangedPane:132](../../../src/features/files/FilesChangedPane.tsx#L132), [Modal:116–139](../../../src/components/Modal.tsx#L116), [Settings:112](../../../src/features/settings/SettingsModal.tsx#L112).                                                                                                    | Semantic row buttons; named close/back actions; dialog labeling, focus trap and restoration. Verify keyboard and screen-reader paths rather than asserting compliance.                                       |
| R8  | P2       | open   | **Code + probe:** a dirty, non-streaming lane without a PR classifies as idle; new live sessions without disk paths have no board card. “Needs a push” also contains failed checks and requested changes. [Classifier:151–176](../../../src/features/home/laneState.ts#L151), [join:71–74](../../../src/features/home/LaneBoard.tsx#L71).                                                                                                                                                             | Extend the existing board into a local review/attention inbox, including unpublished work; use labels naming the real next action.                                                                           |
| R9  | P2       | open   | **Code:** model draft restoration updates picker-local state, but startChat does not pass that selection into createSession. Compose with A, change the global default to B elsewhere, return to A's draft is a runtime reproduction candidate. [Picker:51–53,96–104](../../../src/features/home/HomeModelPicker.tsx#L51), [start:94–95](../../../src/features/sessions/startChat.ts#L94).                                                                                                            | Pass explicit model/provider/effort at launch; read back the actual run identity. Do not report the suspected mismatch as runtime-confirmed.                                                                 |
| R10 | P2       | open   | **Code:** Cmd+K includes only eight sessions from the current cwd; the sidebar has broader project/worktree search. [Palette:65,179](../../../src/features/palette/CommandPalette.tsx#L65).                                                                                                                                                                                                                                                                                                           | Share a project-wide searchable lane index; add decisions and deliverables only when their durable identities exist.                                                                                         |
| R11 | P2       | open   | **Code:** Home headline stats query one cwd, while lane spend spans the project; PR fetch failures can collapse to an empty map. [Home:71](../../../src/features/home/WorkspaceHome.tsx#L71), [Ledger:50–61](../../../src/features/home/Ledger.tsx#L50), [PR store:15–16,79–86](../../../src/stores/pullRequests.ts#L15).                                                                                                                                                                             | Align scope and freshness; distinguish unavailable information from zero spend/no PR. Keep memory estimates explicitly approximate.                                                                          |
| R12 | P1       | open   | **Observed crash banner; fallback code-traced:** killing the isolated stub rendered “Resume session.” Resume disposes local state before lookup and creates a new session if the saved entry is unavailable. [banners:17–28](../../../src/features/chat/banners.tsx#L17).                                                                                                                                                                                                                             | Show the last durable turn and exact recovery target; preserve interrupted context; explicitly distinguish resume from restart. Mid-turn/missing-file recovery was not exercised.                            |

## Reimagined experience

Use three complementary surfaces, not a mandatory wizard:

1. **Project overview:** evolve the existing lane board into an attention list.
   Show what changed since the last visit, the decision needed, and one relevant
   action. Background work stays quiet. Workspace Skills/Artifacts work without chat.
2. **Work canvas:** Brief / Changes + evidence / Context, with Conversation always
   reachable. Remember the chosen view; do not auto-switch while someone is reading.
   The composer can discuss a selected diff, failed check, or decision with its
   reference attached, instead of requiring a copy/paste recap.
3. **Delivery packet:** the reviewed revision, acceptance criteria, net changes,
   check records, screenshots and known omissions. Export a portable document or
   explicitly attach it to a PR; opening an artifact is not publishing it.

The lane remains an independent session/worktree. A human can group lanes under an
outcome without adding a coordinating model, fleet manager, or automatic merging.

## Proposed components and experiments

All rows below are **proposals**, not existing features or committed scope.

| Component                        | Concrete interaction                                                                                                                                         | New value over the current app                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Revision-bound review canvas** | Select an acceptance criterion and see related hunks, its check command/output, and what remains untested. An edit changes a prior green receipt to “stale.” | Connects intention, implementation and observed evidence; does not confuse a successful tool call with correctness.                                       |
| **While-you-were-away strip**    | “Two files changed since your review; one new question.” Open only that delta or snooze the question.                                                        | Evolves the board/unread marker into an attention tool, not another Kanban or notification feed.                                                          |
| **Optional task brief**          | Pin goal, constraints, acceptance examples and open decisions above a lane. Expand only when useful; simple tasks stay one prompt.                           | Keeps the agreement visible through long sessions without imposing plan/approval gates.                                                                   |
| **Context passport**             | Inspect source revisions, observed reads, summaries and handoff decisions; select what to carry into a fork/model switch.                                    | Complements the existing context meter with meaning and provenance. A referenced file is not necessarily read; estimates are not exact request contents.  |
| **Runtime and recovery shelf**   | Find this lane's dev server/port, last command, last durable turn, current files and resume target in one place.                                             | Extends existing terminal tabs and crash recovery. Conversation rewind, filesystem restore and remote side effects must remain explicitly distinct.       |
| **Integration rehearsal**        | Select lane heads; combine them in a disposable worktree; inspect conflicts and combined-check results before choosing merge order.                          | Tests whether individually good changes work together. Explicit, bounded and never an automatic main-branch merge.                                        |
| **Alternative comparison bench** | Fork two approaches from the same base and brief; compare behavior, diff size, checks and recorded cost side by side.                                        | Turns existing forks/provider choice into controlled experiments. Opt-in spend, no automatic model councils or claims of model-independent grading.       |
| **Evidence-to-skill promotion**  | Select a successful procedure, redact it, add a trap fixture and a smoke check, then save a draft project skill with source links.                           | Builds on the shipped Skills library; reusable verified procedure rather than indiscriminate chat memory.                                                 |
| **Behavior preview annotations** | Pin a comment to a before/after screenshot or named UI state and attach its revision/viewport to the next prompt.                                            | Reviews outcomes, not only code. Start with captured evidence; a live app preview needs a separate threat model, never wider artifact iframe permissions. |
| **Decision trail**               | Revisit “Why did we choose polling?” through a concise decision, alternatives, source links and the changed code. Mark it superseded explicitly.             | Durable engineering rationale without searching entire transcripts or introducing silent cross-project memory.                                            |

## Build order and decision gates

| Order                              | Small, separate slices                                                                                                                            | Verification before expanding                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Now: trustworthy basics**        | Baseline/restore safety; complete net-change inventory; consistent PR/readiness labels; keyboard/modal fixes; workspace-level library navigation. | Lost-ref and resume fixtures; shell edit/delete/rename coverage; no-CI/conflict/review-required table tests; keyboard-only review path.                                           |
| **Next: thin review canvas**       | Receipt contract/storage and explicit check runner; read-only evidence UI; revision-keyed human review state; local/no-PR inbox.                  | Edit after tests → stale; checks mutate files → cannot certify the original snapshot; reopen → same receipt; unavailable results stay unknown.                                    |
| **Then: context and delivery**     | Task brief, source-linked handoff, delivery packet, decision trail.                                                                               | A user resumes an unfamiliar lane without transcript archaeology; exported claims point to exact revision/evidence; redaction review precedes sharing.                            |
| **Explore only after observation** | Rehearsal, comparison bench, preview annotations and skill promotion.                                                                             | Compare current vs proposed workflows with practicing engineers; measure review time, missed defects, context-recovery time and spend. No claimed improvement without a baseline. |

Receipts should record command/recipe hash, cwd, HEAD plus dirty/relevant-untracked
content fingerprint, runner identity, toolchain/environment identity without
secrets, timestamps, exit status and output reference/digest. A SHA alone does not
identify uncommitted work. Distinguish **agent-reported**, **locally observed**,
**GitHub-reported**, and **human reviewed** evidence. Exit zero does not prove
correctness; local records under the same OS user are not tamper-proof attestation.

Store new metadata in main-owned sidecars, not direct writes to pi's live JSONL.
Keep renderer state a projection; refresh on bounded events, not unbounded watchers
or token-spending background observers. Full external-provider results and exact
request manifests require upstream instrumentation; the current marker text and
context estimates cannot reconstruct them.

**Do not build next:** another agent fleet/orchestrator, obligatory tool approvals,
a giant agent graph, a full second IDE, automatic model competitions, silent global
memory, mandatory cloud sync, or confidence percentages without evidence. Preserve
local ownership and the artifact sandbox (`allow-scripts`, no `allow-same-origin`,
no `connect-src`).

## Verification and limits

- Read current docs/tokens and inspected committed screenshots as secondary evidence;
  README screenshots do not reliably depict the latest Home board or Skills surface.
- Built and exercised isolated stubbed Electron on macOS: onboarding, Home, streaming,
  Changes/diff, Files, artifacts, Settings, palette and an induced stub process crash.
  Inspected light/dark captures and 1440×920 / 1000×740 CSS-pixel layouts. Stub prose,
  costs and edits are fixtures; the stub's edit event is not a real model code change.
- Browser mock: inspected Home/ledger; exercised Settings keyboard traversal and
  actual classifier/chip functions with conflicting/no-CI/dirty-no-PR inputs.
  Synthetic board-state injection did not persist through mock rescans, so this is
  **not** a visual verification of a fully populated live lane board.
- `npm run typecheck`, `npm run lint`, `prettier --check .`, `npm run build` passed.
  `npm test`: **159 files / 1,832 tests passed**. `npm run test:e2e`:
  **36 passed**. An initial unit run failed during concurrent first-use Electron
  extraction (directory already exists); the unmodified suite passed after install
  settled. No check was weakened.
- The companion Review Desk concept was rendered at 1360, 1000 and 390 px, in
  light/dark themes, with no body overflow. Tab/arrow-key navigation, independent
  human review, stale-evidence transitions, reset, disclosure and explicit theme
  overrides passed browser checks. It is a simulation, not a live check runner.
- `npm audit` reported **5 affected packages: 3 moderate, 2 high**, including direct
  Mermaid and transitive DOMPurify, xmldom, fast-uri and nanoid. Advisory presence is
  not evidence of reachable exploitation; dependency triage is separate follow-up.
- No live paid model turns, customer interviews, production-scale performance study,
  Windows/Linux runtime review, screen-reader audit, or data-loss reproduction.
  This is a broad product/design assessment, not a complete security audit.

## External reference points

Official sources opened 2026-09-05, used as interaction references, not comparative
benchmarks or proof of a unique market position:

- [OpenAI worktrees](https://developers.openai.com/codex/app/worktrees): parallel
  checkouts and explicit Local/Worktree handoff. Parallel sessions alone are not a
  defensible future differentiator.
- [Cursor Agent overview](https://cursor.com/docs/agent/overview): code checkpoints
  are distinct from conversation history. Make recovery semantics explicit.
- [GitHub agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents): commits link back to session logs.
  Engineering evidence should travel with the delivered work.
- [Microsoft Human-AI Interaction guidelines](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/): design initial use, ongoing work,
  failures and correction together, not just the happy path.
- [WCAG contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html):
  4.5:1 normal text; 3:1 qualifying large text. Token ratios are scoped checks, not
  a whole-app accessibility verdict.
