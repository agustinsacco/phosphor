# Post-PWA re-plan brief

## Context
Phosphor is a monorepo under engineering remediation. The plan (`plans/program.json`) was written before the mobile-PWA lane merged (PR #514, `778cc283`). Current main is `c08625cc`. A clean, read-only checkout of current main is at:

`/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/wt/nm-main`

Use it for all reading. Do NOT edit anything in it, and do not run git commands that change it.

The PWA merge reshaped the code:
- Almost all of the renderer moved from `apps/desktop/src/**` to `libs/client-ui/src/**`, which is shared by Desktop and the new `apps/web` PWA. `apps/desktop/src` now holds only `main.tsx` and `index.html`.
- There are two new packages: `libs/host-client` and `apps/web`.
- Many files changed, split, merged or were renamed.

Read `CLAUDE.md` and `README.md` (the repo layout section) in that checkout first. `/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/COORDINATION-PWA.md` records which units were held and why.

## Your input
A JSON array of plan units: `replan/in/<group>.json` in the scratch dir. Each unit has:
- `owns`: paths the unit may change;
- `reads`;
- `design`;
- `characterize_first`;
- `new_tests`;
- `existing_tests`;
- `verify`: shell commands;
- `acceptance`;
- `findings`: review finding ids;
- `depends_on`.

## Your job
Re-validate every unit against current main and write a proposal. Do not implement anything.

For each unit decide one `action`:
- **`keep`**: the spec is still correct as written. Paths exist and the finding still reproduces.
- **`remap`**: the finding still holds, but paths, function names or line references moved. Supply the corrected fields.
- **`rewrite`**: the finding still holds, but the PWA restructure means the design must change. Supply the new `design`, `owns`, tests and verify. Keep the original intent and acceptance.
- **`drop`**: the finding no longer applies, for example because the PWA already fixed it or the code is gone. Give concrete evidence: a file, a line and what you saw.
- **`merge`**: the unit should fold into another unit. Name which one.

## Rules for corrected specs
- Every path in `owns`, `reads` and `existing_tests` must exist on current main, unless the unit creates it. Mark created paths in `creates`.
- **Test locations.** Unit tests still sit beside their source as `*.test.ts(x)`, because the relocation to `test/` folders has not run yet.
  - Specs written for after the relocation (`apps/desktop/test/renderer/...`, `.../test/main/...`) must be rewritten to the colocated path that exists today, or will be created, beside the subject.
  - The relocation unit will move them later.
- **Size budgets:** source file ≤400 lines, function ≤80 lines, test file ≤800 lines. Ceilings are in `tools/budgets/<package>.json`.
  - Note the package that now owns a file; `client-ui` has its own budget file.
  - Use `node tools/scripts/size-budget.mjs` and the size-span tooling in the checkout to measure current sizes, where useful.
- **`verify` commands** must run from the repo root on current main, for example `npx vitest run <paths>` and `npx tsc --noEmit -p <tsconfig>`. Check that tsconfig names exist.
- **Contracts:**
  - Do not change IPC channels, the `libs/shared` protocol, status keys, or Host/Web wire contracts.
  - If a unit now has to touch `apps/web` or `libs/host-client`, flag it in `risk_notes`. Those are web-exposed.
- **Dependencies:** `depends_on` may reference unit ids or group keys. Drop dependencies on units that are already merged; the list is in `exec/state.json`, `status === "merged"`. Keep the others.
- **Splits:** if one unit now spans both `libs/client-ui` and `apps/desktop/electron`, keep it as one unit only if the change is genuinely coupled. Otherwise propose a split, giving new ids such as `<ID>a` and `<ID>b`.
- Be concrete: real paths, real symbol names, real line counts. Do not guess. Open the file.
- Effort: read only what you need. For each unit, check its paths and grep for its symbols. Open source only where a finding must be re-verified.

## Output
Write `replan/out/<group>.json`: a JSON array with one object per input unit, in input order:
```json
{ "id": "...", "action": "keep|remap|rewrite|drop|merge",
  "evidence": "1-3 sentences, with file:line",
  "patch": { /* only fields that change, using the same keys as the unit; plus optional "creates": [] */ },
  "split": [ /* optional: full new unit objects */ ],
  "merge_into": "ID or null",
  "risk_notes": "optional" }
```
Validate it with `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' <file>`.

Then reply with a short report:
- counts per action;
- the 5 most important judgement calls;
- any unit you could not resolve.

## Extra for heldcore chunks
These units were held because the PWA lane edited their files.

If RL-02 or RL-03 (relocation) is in your chunk:
- The merged RL-01 map (`tools/scripts/relocation/map.mjs` on main) predates `libs/client-ui`, `libs/host-client` and `apps/web`.
- Propose a new unit RL-01b, in the `split` of RL-02. It extends the map to those packages, with `src` → `test` mirrors that match the existing conventions.
- Update RL-03's `owns` and notes for the new layout.
