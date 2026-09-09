# The orchestrator tool table is now a test, not a promise

`specs/reference/orchestration.md` documents ten tools the orchestrator can
call. An audit on 2026-08-30 (`spec-drift-2026-08-30.md`, deleted 2026-09-09 at zero open findings)
found **five of the ten rows had the wrong arguments**, including two tools
documented as taking none that in fact require one, and one documented as
taking a `DigestPayload` type that has never existed.

That table is not decoration. It is what a person — or an agent writing
orchestrator code — reads to learn how to call these tools, and reading it got
you a call that pi rejects before `execute` runs.

## Why this one drifted and the pi protocol mirror did not

`shared/rpc.ts` mirrors an external protocol by hand and has not drifted,
because `_NoMissingResponseKeys` / `_NoExtraResponseKeys` make a mismatch a
compile error. The orchestrator's tools had no such link: the schemas live in
`pi-ext/orchestrator.ts`, the table lives in markdown, and markdown has no
compile step. Every argument change since the tools shipped was free.

## What changed

- `pi-ext/orchestrator.ts` now declares its tools as data — an exported
  `ORCHESTRATOR_TOOLS` array — and the default export is a dumb registration
  loop over it. No behaviour change; the array is what makes the contract
  readable from a test.
- `pi-ext/orchestrator-doc.test.ts` parses the table under `### Tools` and
  asserts, per tool, that the documented argument names equal the schema's,
  with a trailing `?` meaning optional. Prose is deliberately unchecked — a
  guard that also polices wording gets deleted the first time it is annoying.
- The table was corrected until the guard passed. **Verified non-vacuous the
  only way that counts: it was written before the doc was fixed, and it failed
  on exactly the five rows the audit had found by hand, plus the tool-name set.**
- `DigestItem.action.kind` narrowed from five kinds to `'start'`. The bridge
  only ever synthesized `start` from a per-item `startPrompt`, and
  `FleetOverview` only ever rendered `start`; `open`, `resume`, `archive` and
  `merge` were a union nothing produced and nothing consumed.
- Nine more prose claims in the same doc corrected: `projectRoot` missing from
  the documented `FleetSession`, a `question` sweep kind that `SweepKind` never
  had, a "once when a workspace opens" trigger that does not exist (and that
  the same doc contradicted 80 lines later), a `workspaceStats()` function that
  does not exist, `OrchestratorRow.tsx` which does not exist, and three manual
  tests describing a UI the doc's own Differentiation section already described
  correctly.

## The rule this suggests

A doc that describes a **signature** should be enforced, not trusted. Prose
about intent is fine to leave to review; an argument list is data, and data
that two files hold independently will diverge. Both places this repo mirrors a
contract by hand now have a guard.
