# Removing the lane loop pane

2026-08-28

The lane loop is gone: the `pi-ext/lane-loop.ts` extension, the banner above
the composer, the ladder on the fleet card, and the `LaneLoop` wire types.

## Why

It did not earn its place. The ladder occupied the most valuable strip in the
window — directly above the composer — on every turn of every session, and the
answer it gave was one the user could get from the terminal when they wanted
it. It also ran typecheck, tests and lint on every settled turn, which is real
CPU spent whether or not anyone was looking.

The idea it encoded is still right: **a claim of "done" backed by prose is not
evidence, and only the harness may fill a rung.** That part is meant to come
back in a different shape. This removal is not a retraction of the argument in
[2026-08-27-lanes-and-the-ladder.md](2026-08-27-lanes-and-the-ladder.md), only
of this presentation of it.

## What was removed

- `pi-ext/lane-loop.ts`, and its entry in `bundledExtensions()`.
- `src/features/lanes/` — `LaneBanner`, `LaneLadder`, `laneLoop.ts` and its tests.
- Its two mount points: above the composer in `ChatView`, and on `SessionCard`.
- `LaneRung`, `LaneRungState`, `LaneLoop`, `DEFAULT_LANE_RUNGS` and
  `DEFAULT_DIFF_BUDGET` in `shared/models.ts`.
- The `Phosphor-lane-loop` key from the status strip's structured-key list, the
  stub's lane payload, and the two e2e tests that covered the banner.

## What deliberately stayed

- **The lane charter** (`laneCharterBlock` in `electron/pi/directives.ts`). A
  lane still owns its branch, still ends in a pull request, and is still asked
  to keep the change reviewable. Only its claim about the ladder changed: it
  now says to run the project's own checks before claiming the work is done,
  because a system prompt that describes a pane that no longer exists is worse
  than no line at all.
- Worktree-per-lane, the orchestrator and its fleet tools, and every other
  bundled extension.
