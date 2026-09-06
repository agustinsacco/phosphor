# Vision — from editor to deck

**Status: direction, not commitment.** A full UI/UX renewal sketch written
2026-09-05, answering "what is this app missing, and what would you build?"
Nothing here is shipped; nothing here is scheduled. When a piece lands, it gets
a `docs/log/` entry and this file loses that section.

## Thesis

Every IDE ever shipped is a typing instrument: file tree, buffer, cursor. pidex
already lives in a different world — agents do the typing, work runs as lanes on
worktrees — but it still wears a chat app's clothes. The renewal is an
inversion: stop decorating the transcript, and build the instrument for the
resource that is actually scarce — the operator's judgment.

**The design spine is the fan-out equation: `FO = 1 + NT/IT`.** Fan-out is how
many of you exist today: one, plus the ratio of time lanes run unattended (NT)
to the attention each touch costs (IT). A feature earns its pixels only by
moving a term. Every concept below is tagged with the term it moves.

## What exists vs. what is missing

Already in the walls: lanes on worktrees with branch control; sandboxes; forks,
bookmarks and branch jumps in pi's session format (time-travel primitives,
unexposed); five in-turn extensions, two of which may refuse or rewrite a
model's action; a live context meter; PR and per-lane-prefs stores.

The six absences:

1. **No fleet surface.** Sessions are a sidebar list; fleet state lives in the
   operator's head. (Orchestration was removed deliberately on 2026-09-03 — the
   answer is a projection, not a manager.)
2. **Claims without receipts.** "Tests pass" is prose in a transcript; the
   evidence exists only as scrollback.
3. **Review is raw diff reading.** No behavioral summary, no confidence signal,
   no adversarial pass in the loop.
4. **Code with amnesia.** A line cannot say which turn, prompt, or model
   produced it, or what covers it.
5. **Lanes are blind to each other.** Two worktrees converge on one file; the
   operator learns at merge.
6. **Nothing compounds.** Corrections vanish into transcripts instead of
   becoming house law — and everything stops when the operator stands up.

## Altitude 1 — the Deck (the fleet)

Home screen becomes a flight deck, not a file tree.

- **Flight Strips** (↓IT; seed: `electron/registry.ts` + session scan) — every
  lane is a strip moving through bays: chartering → running → needs-you →
  landing. The deck is a pure projection of the registry and disk scan; no
  orchestrator returns.
- **The Pager** (↓IT) — one queue for every decision the fleet owes the
  operator, ranked by blast radius × staleness, each item priced in
  minutes-of-you. Drain a queue; never poll lanes.
- **Collision Radar** (↑NT; seed: `src/stores/worktrees.ts`) — worktrees diffed
  against each other continuously; two lanes trending toward the same region
  warn before the conflict exists, with a move attached (fence, order, rebase).
- **Fan-out Meter** — the one honest vanity metric: how many of you ran today,
  from real timestamps. If UI work doesn't move this gauge, it was decoration.
- **Previously On** (↓IT) — mornings open with a 90-second replay across all
  lanes, told as one story rather than n transcripts.
- **Wall of Undone** (↓IT) — everything agents noticed but didn't touch parks
  as a card that can be flicked into a fresh charter, instead of dying in
  scrollback.

## Altitude 2 — the Lane (one unit of work)

A lane is a contract with a lifecycle, not a chat.

- **The Charter** (↑NT) — a lane opens with a three-question interview and
  closes against the answers: definition of done, constraints, non-goals,
  pinned. A drift meter compares the growing diff to the charter.
- **The Scrubber** (↓IT; seed: `electron/pi/session-writer.ts`) — the lane's
  history as a filmstrip; scrub to the moment it went wrong and fork from
  there. The instrument panel for forks/bookmarks/branch-jumps that already
  exist.
- **Multiverse** (↑NT; seed: worktrees + sandboxes) — a risky charter spawns
  three attempts in three worktrees and lets them race; the podium shows each
  diff with receipts and cost; crown one, compost the rest.
- **The Airlock** (↓IT; seed: `src/stores/pullRequests.ts`) — nothing lands
  without passing through. Review leads with behavioral claims chained to hunks
  and receipts; the text diff is the appendix. A Cross-examine button spawns an
  adversarial judge lane against the claims.
- **Autonomy Dial** (↑NT; seed: `src/stores/lanePrefs.ts`) — per-lane leash
  from "ask before every write" to "wake me on the second failure",
  auto-lowered by blast radius, raised by the trust ledger.
- **Rehearsal** (↑NT; seed: sandboxes) — risky changes perform in a sandbox
  first and show the trailer (diff, test run, screenshots) before touching the
  branch.

## Altitude 3 — the Line (the code itself)

- **Intent Blame** (↓IT) — hover any line: the lane, turn, model, what the
  human actually asked, which tests cover it. git blame answers who; intent
  blame answers why.
- **Heatmap of Doubt** (↓IT) — the model marks the hunks it trusts least; the
  diff renders hot-to-cold and review starts where doubt lives.
- **The Living Map** (both) — the codebase as a persistent map: lanes as
  weather over their regions, churn accumulating as visible wear. A module
  patched eleven times this month looks tired.

## Altitude 4 — the House (knowledge that compounds)

- **The Garden** (↑NT) — repeated corrections are proposed as house rules;
  accepted rules bind every future lane. CLAUDE.md becomes a constitution
  tended in the UI, not a hidden file.
- **Trust Ledger** (↑NT) — per model × per region track record (first-pass
  review rate, revert rate, cost) that feeds the autonomy dial and model picks.
- **Traps** (↑NT) — a correction captured as a fixture: situation, wrong move,
  right move. Future lanes are smoke-tested against the traps. Judgment becomes
  a regression suite.

## Altitude 5 — the Body (beyond the desk)

- **The Kitchen** (↓IT) — sound as ambient state: a landing lane chimes, a
  blocked one drops a lower tone, a full deck hums. You know the kettle boiled
  without watching the stove.
- **Pocket Deck** (↑NT) — the pager on a phone: approve, redirect, or kill.
  NT should not end when the operator stands up.

## The feel

Three directions were considered: **Quiet Cockpit** (Phosphor matured —
editorial calm at rest, instrument precision on demand; two densities, not two
themes), **Terrarium** (lanes as living things; whimsy taxes clarity at twenty
lanes), and **Broadcast** (the day as a control-room story; strongest narrative
surfaces, heaviest chrome). Verdict: build Quiet Cockpit as the body; steal
Terrarium's lifecycle verbs for lane states (bloom, wilt, compost) and
Broadcast's morning recap.

## Build order

All four moves run on rails that already exist:

1. **Receipts** — an extension already sees every tool result; chip claims to
   evidence in the transcript. Smallest diff here; changes the epistemics of
   everything else.
2. **Deck v1** — strips + pager as a passive projection over registry + disk
   scan. Needs-you detection, minutes-of-you pricing. No orchestrator.
3. **Airlock v1** — claims-led review with receipts inline; Cross-examine
   spawns a judge lane in a fresh worktree.
4. **Scrubber v1** — the filmstrip over forks, bookmarks and branch jumps
   already on disk.

Then: Charter + drift meter → Collision Radar → Trust Ledger feeding the
Autonomy Dial → Pocket Deck (needs the Pager first).

The closing bet: the first great AI IDE won't be the best place to write code —
it will be the first instrument that makes one person's judgment legible to a
fleet.
