# Workspace orchestration: the fleet hub, an agent that manages agents, and a home screen that shows the work

**2026-08-22.** The home screen was a greeting and every session was an island:
"what is everything doing right now?" was answered by clicking through the
sidebar. This lands the design in `13-orchestration.md` — three layers,
strictly ordered by cost.

> **All of it was removed on 2026-09-03** — the orchestrator, the fleet hub,
> and the design doc — see
> [remove-orchestration](2026-09-03-remove-orchestration.md). Nothing described
> below is current behaviour; the home screen that survived is the lane board.
> Kept because the removal only makes sense against what it removed.

## What shipped

**Layer 1 — the fleet hub (`electron/orchestrator/`), zero inference.**
`SessionRegistry` now emits `created`/`disposed`, so `FleetHub` attaches to
every live session without any creation path having to remember to tell it.
`fleetReducer` is a pure function from pi's event stream to a per-session
record (phase, last prose line, current tool, files touched, pending question,
idle time). Snapshots broadcast to every window, debounced 150 ms; the reducer
returns its input unchanged for events that carry nothing the UI shows, which
is what keeps `message_update` off the broadcast path.

**Layer 2 — the orchestrator, one pi session per project.** Spawned through the
same `spawnSession` path as any other session (extracted from the
`pi:createSession` handler so env, bundled extensions and stub handling can
never drift), plus `pi-ext/orchestrator.ts` and a composed system prompt.

**Layer 3 — rules, memory, autopilot.** `<mainRepo>/.phosphor/orchestrator.md` and
`orchestrator-memory.md`, a per-project prefs record, and a Settings →
Orchestration tab. Autopilot is off by default; without it `propose_work` can
only suggest.

**Surfaces.** The home screen grew an attention inbox (blocked questions render
their real options as buttons and answer in place), per-session cards with an
inline composer that routes to `steer` while streaming and `prompt` when idle,
and a digest line. The stats card moved into a `<details>` — it is a flourish;
the fleet is the point. The sidebar gained an orchestrator row per project.

Also landed because the feature exposed them: a **single-instance lock** (two
Phosphor instances would run duplicate sweeps and race the same memory file) and
**desktop notifications** with an app badge — the app had no notification code
at all, which is a hole when the premise is that agents work while you are away.

## Decisions worth keeping

**The control channel is not a socket.** Extensions run inside pi and must
reach main. `ExtensionUIContext.input()` returns `Promise<string | undefined>`
and, in RPC mode, round-trips through the `extension_ui_request` /
`extension_ui_response` pair Phosphor already implements (verified against pi
0.84.2: `dist/core/extensions/types.d.ts`, and `examples/rpc-extension-ui.ts`
demonstrates the loop). So a request whose title carries `Phosphor-fleet:v1` is
intercepted in main and never forwarded to the renderer. No listening port, no
token, no `app.isPackaged` gate to get wrong. **Authorization is structural**:
main honours the sentinel only from a session it spawned as an orchestrator, so
an ordinary session cannot use it as a covert channel — and that rule is the
first line of `handleFleetCommand`, with tests.

**No per-event inference.** An always-on agent was designed and rejected: it
makes a model the price of opening the app. Sweeps (`brief` / `review`) are
user-initiated, refused rather than queued while one is running, and
rate-floored.

**One session, not a pool.** An earlier draft split sweeps into ephemeral
sessions to keep the conversation thread small. Cut: pi's auto-compaction
already bounds context, `/compact` is already wired, and the split bought
complexity to solve a solved problem.

**`/new` deliberately not wired.** pi has no `/clear`; its `/new` starts a
_different_ session and would rebind the live process to a new file,
invalidating the prefs pointer below and stranding renderer state. Compaction
is sufficient.

**Identifying an orchestrator session, two ways.** It runs in the project's own
cwd, so nothing distinguishes it structurally. `isOrchestratorSession()` in
`shared/` is the single choke point, backed by a prefs pointer (which doubles
as the resume target) and a session-name sentinel that survives a prefs reset.
Missing one consumer is the bug this exists to prevent: without it the
orchestrator inflates the sidebar, the home tiles and the heatmap. It is
excluded from those; Usage deliberately still lists it, labelled — hiding what
it costs would be worse than showing it.

**The visible-hand rule.** Anything main injects on the orchestrator's behalf
arrives as a new `SessionPush` variant (`injected`) and is rendered in the
target's transcript immediately. pi persists it either way; this fixes what the
_live_ UI shows, so a session being steered is never silently steered.

## Verification

`npm run validate` fully green: typecheck, lint, prettier, **931 unit tests
across 91 files**, and **26 e2e**. New unit suites cover the reducer (phase
transitions, `filesTouched` bounding, the guard that a pending question
survives `agent_settled`, and that `message_update` returns state by
reference), the bridge (dispatch plus every authorization refusal),
notification coalescing, inbox ranking, and the identity predicate. Two new
e2e tests cover the mechanical layer: a live session becoming a home card you
can steer, and the orchestrator row being distinct from session rows.

**Honest scope limit on e2e:** the stub is spawned without Phosphor's bundled
extensions, so the orchestrator's tools cannot run under Playwright. Tool
behaviour is covered by unit tests over `handleFleetCommand` with a fake
registry instead, and the e2e test says so in its own comment.

**Flakes seen while landing this, all confirmed not caused by it.** Twice
during development the full suite failed `reopens the last session on relaunch`
and/or `sidebar groups sessions from several workspaces`, which pass in
isolation and as a pair. Confirmed pre-existing by stashing this entire branch
and re-running the suite on clean `main`, where the same two failed the same
way; they pass in the final run above. Every test shares `PI_CODING_AGENT_DIR`,
which is the likely cause — untangling it is its own change.
`hydrationScale.test.ts` also tripped twice under machine load (it asserts wall
-clock budgets: 400ms and a linearity ratio) and passes unloaded.

**Five bugs the green suite missed, found by driving the real app** (real pi,
a local Qwen and Haiku). Recorded because they are the argument for doing this
before shipping, not after: opening the orchestrator dropped the app to the
workspace picker (main-spawned sessions were never adopted into the renderer's
`live` map, which `useActiveWorkspace()` reads); the orchestrator was blind to
worktree sessions, so a real sweep opened with "No sessions are running" while
one plainly was; the home header said "Nothing running" above a running-now
card; fleet cards read "Untitled session" beside a sidebar row with the real
title; and a failing sweep was silent, leaving the button un-pressed and
nothing ever appearing. Each is fixed with a regression test.

A sixth was behavioural rather than a defect: a capable model did a full sweep,
wrote an excellent summary in chat, and never called `publish_digest` — so the
home screen stayed empty. The sweep prompt now states publishing as the
definition of success rather than as a trailing clause.

One real bug in the new e2e was found and fixed rather than retried: it clicked
the session card's trailing button to open the session, but that button is
**Stop** while the session is streaming, so it aborted the run instead of
navigating. It now opens from the sidebar row.
