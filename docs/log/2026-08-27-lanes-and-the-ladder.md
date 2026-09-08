# Lanes, the loop ladder, and four defects that made lanes unsafe

2026-08-27

> **Superseded 2026-08-28.** The ladder and its banner were removed; the
> feature is meant to return in a different shape. Everything below is history.
> See [2026-08-28-removing-the-lane-loop-pane.md](2026-08-28-removing-the-lane-loop-pane.md).
> The lane charter in `electron/pi/directives.ts` and the worktree-per-lane
> flow both stay.

## Why

A research pass over the agentic inner loop (published as a five-part series;
see [the fleet notes](#references)) produced one conclusion that changed the
plan: **the fleet dashboard is the wrong artefact.** Endsley & Kiris measured
that under automation, Level 2 situation awareness (comprehension) degrades
while Level 1 (perception) is unaffected. A richer board adds the faculty that
was never broken. The market ran the experiment too — Vibe Kanban executed the
board metaphor properly, reached 27.9k stars and thousands of daily users, and
shut down in April 2026.

What survives is narrower and better: make the unit of work legible, make its
state mechanical, and make the human's queue short.

## What changed

### The unit of work is a lane

"Session" names a process. The unit a person holds in their head is the work:
what it is for, where it may write, how it is judged, and how it ends. So the
noun is **lane**, and it is a specific bundle: one charter, one branch, one
worktree, one agent process, one acceptance ladder, one pull request.

### The lane loop

Six rungs, fixed per project, in fixed order: `tsc · test · lint · diff ·
merge · pr`. The ladder is the lane's **state**, as distinct from the
transcript, which is only its history.

**Only the harness executing a command may fill a rung.** `pi-ext/lane-loop.ts`
runs the ladder at `agent_settled` and publishes over the status channel the
context meter already uses. The model has no tool that writes a rung and cannot
see the interface, so its claims never touch it. That constraint is the whole
feature: a benchmark audit found 1,000+ validated cheating instances across
nine agent suites, including an Opus 4.6 agent that wrote code printing `PASS`.

Two rungs are oracles nothing else in this market computes:

- **`diff`** fails above 400 changed lines or 20 files. SmartBear/Cisco
  measured defect detection falling from 87% under 100 lines to 28% over 1,000,
  and useful-comment share degrading past ~20 files. An unreviewable change is
  a failed acceptance test, and the surface should say so before you open it.
- **`merge`** is a `git merge-tree --write-tree` dry run against the base —
  the same replay that measured 27.67% of agent PRs conflicting.

`pr` sits unfilled from turn one. An empty rung is a better standing
instruction than a paragraph, because it does not compact away.

The extension runs **processes** rather than intercepting tool calls, which
makes it the one lever that behaves identically on a native provider and on the
Claude Code bridge, where CLI-internal tools never reach `tool_call` at all.

### One component, two mount points

`LaneLadder` renders on the fleet card and, new, in a banner directly above the
composer inside the lane. The second mount is the one missing from every tool
in this category: you open a session and the software stops telling you where
the work is.

Colour is ISA-101: passing rungs stay grey, so the one failing rung on a screen
of ten lanes is the only thing colour is spent on. `laneHint()` names the next
thing that has to be true, generated mechanically from rung state, which is
what lets it be permanent and lets it be trusted.

### The directive stack is now a setting

`electron/pi/directives.ts` owns layer 2 of what reaches a lane: the worktree
guard, the lane charter, then the user's own text, in that order, with a global
default and a per-project override, and the composed result shown in
Settings → Agent before it is sent.

It has to be a setting because the right contents now depend on the model.
Anthropic cut its frontier harness prompt from roughly **2,686 words to about
514** with memory off (the widely quoted 80%) and about **830** with memory on
(nearer 70%), and the cut is **frontier-only**. A mixed fleet therefore needs a
lean profile and a fuller one, and a constant compiled into the app cannot
express that.

_Sourcing caveat: this traces to a talk plus secondary write-ups, not to
first-party documentation. Sources also disagree on whether Opus 4.8 gets the
lean prompt. Treat the exact figures as directional._

## Four defects fixed

Each was found while designing the above, each is confirmed in shipped code,
and three of them silently invalidate anything built on top of them.

1. **The session baseline dropped the files it exists to protect.**
   `createSessionBaseline` used `git stash create`, which silently omits
   untracked files — exactly the class that was unrecoverable when two sessions
   collided in one tree ([TRACKER.md:114](../specs/TRACKER.md)). Replaced with a
   throwaway-index snapshot. Two load-bearing details: `GIT_INDEX_FILE` must
   live outside the worktree (point it inside and `git add -A` captures the
   index into the tree it is indexing), and the identity is forced in the env
   because `commit-tree` fails outright without `user.email`.
2. **Autopilot spawned into the main checkout.** Worktree isolation lived
   entirely in the renderer, so `startWork` passed a bare `workspacePath` to
   `spawnSession`. User-started sessions were isolated; orchestrator-started
   ones were not. The layer built to prevent the collision was reintroducing
   it. `electron/fs/lane-workspace.ts` now does the isolation in main;
   `shared/branchName.ts` moved out of `src/lib/` so main shares the one slug
   implementation rather than growing a second.
3. **A destructive confirmation could be silently answered "no".**
   `session_answer` parsed a confirm by truthiness, so a model replying
   "affirmative" or "y" answered **no** — and the transcript honestly recorded
   that it had. `parseConfirm` is a closed set with an explicit unknown; an
   unrecognised value is refused so the model can retry.
4. **Peer output reached the privileged thread undelimited.** A lane's
   `lastLine` was interpolated raw into the sweep prompt and `session_read`
   returned another lane's transcript verbatim, into the one thread holding
   `session_send` and `session_stop` over its peers. That is the
   injection-laundering path, and `specs/reference/orchestration.md` does not name it once.
   `electron/orchestrator/untrusted.ts` frames lane-written text in a per-call
   nonce envelope and scrubs zero-width, bidirectional and Unicode tag
   characters. Structural fields the runtime produced stay plain.

## Evidence

- typecheck, lint, prettier clean.
- **1175 unit tests** (113 files), 30 e2e.
- `git-service.baseline.test.ts` proven non-vacuous: **2 of its 6 tests fail**
  against the `git stash create` implementation.
- The lane-loop e2e proven non-vacuous by removing the `LaneBanner` mount **and
  rebuilding**. Worth writing down: `npx playwright test` alone runs against the
  previous `out/` bundle, so the first attempt at that check passed against code
  that no longer existed. `npm run test:e2e` builds first; a bare playwright run
  does not. This is the same shape as the scar in
  [2026-08-23-e2e-isolation-and-the-missing-regression-test.md](2026-08-23-e2e-isolation-and-the-missing-regression-test.md).

## Deliberately not done

- **The orchestrator keeps its standing authority, for now.** The design
  argument is that it should become an author and an advisor rather than a
  supervisor: its judgment currently runs on `session_read`, which caps at 30
  messages and strips tool-result content, so "progressing / stuck / drifting"
  is decided from a peer's own prose. Removing `session_send` / `session_stop`
  from the standing path and giving it the ladder results as input is a
  behaviour change that deserves its own PR and its own decision.
- **Next Call** (one key, one card, claim-not-resolve) is designed and not
  built. It is deliberately second: a queue with nothing worth taking in it is
  an empty inbox, so the ladder had to land first.
- **Per-project rung configuration.** The ladder reads `package.json` scripts
  and falls back to `unconfigured`. A `.phosphor/lane.json` is the obvious next
  step and is not needed to prove the shape.

## References

The design series this came from: The Stretched Loop · One Eye, Ten Agents ·
The Physics of a Fleet · The Queue Compiler · The Machine Underneath.
