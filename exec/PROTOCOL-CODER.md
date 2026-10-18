# Coder protocol (Phosphor remediation)

You implement exactly ONE unit of an approved remediation plan, in your own git worktree,
on your own local branch. The integrator (parent session) merges your commits; you never push.

## Inputs
- Unit spec: `/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/exec/units/<ID>.json`
  (id, kind, owns, design, characterize_first, new_tests, existing_tests, verify, acceptance, docs, notes).
- Your cwd is the worktree. Its HEAD at start is the BASE sha given in your task.
- Project rules: CLAUDE.md in the worktree (sharp edges, conventions). They apply in full.
- The spec was written by a planner from a read of the code. Validate it against the actual code before
  coding. Line numbers in the spec may be stale. If the design is wrong, unsafe, or needs files outside
  `owns`, STOP and report `BLOCKED: <reason>` instead of widening scope or inventing a product decision.

## Approved owner decisions (apply where relevant)
A1 Routine outcome: Desktop rule, only top-level tool errors (no parentToolCallId) count.
A2 Skill delete: confirmation dialog + move to system Trash, never rm fallback.
A3 HB-TS-STRICT approved. A4 Grant replay within TTL: documented as accepted, no replay cache.
A5 Electron fuses: not in scope. A6 Renderer sender-frame check approved as planned.
A7 Forced terminal stop exitCode -1; package job deadline 15 min; revocation overflow quarantine 15 min.
A8 Rate limits: 8 isolated capacities of 10k keys. A9 Installer checksum fails closed + documented escape hatch.
A10 Routine run history kept (no retention). A11 No exact file-mode enforcement. A12 Feature-local stores allowed.
A13 Budget exemptions: icons.tsx declaration list, LR-11 single-file gate, linear e2e test callbacks.
A14 Deferred e2e coverage stays deferred.

## Commit protocol (the gate enforces every rule below)
Every commit subject: `<type>(<ID>): <imperative summary>`; type in test|fix|feat|refactor|perf|chore|docs|build|ci.
1. If the spec has `characterize_first`: FIRST commit is `test(<ID>): characterize <what>`.
   - Only test files. Tests go through the ORIGINAL public entry and pin today's observable behaviour
     listed in the spec (results, errors, ordering, timing where relevant).
   - They MUST pass on the unchanged source. Run them before committing.
   - After this commit, never edit or delete a line it added. You may append new tests.
2. If kind is fix, security or perf: next commit is `test(<ID>): regression <defect>`.
   - Only test files. They MUST FAIL on the current source, by assertion where possible (not a typo or
     syntax error). Run them and confirm they fail for the stated reason.
   - No source change may land before or in this commit.
3. Then implementation commits (`fix(...)`, `refactor(...)`, ...). Docs listed in `docs` change in the same
   unit, only the named sections. If you fix a docs/known-issues.md row, delete it.
- Decompose units change NO behaviour. Keep public entries stable (facades/barrels). Every new module or
  abstraction gets its own tests. Keep files <= 400 lines, functions <= 80 lines where you create or split
  code; do not grow an already oversized file without need.
- Touch only paths matching `owns` (globs allowed; annotations in parentheses are notes).
- Pre-existing tests that pin the defect may be updated only in fix/security/perf units, with the reason in
  the commit body.
- Format with `npx prettier --write <changed files>` before each commit. Commit with plain `git commit`.
  You may amend or rebase your own unit commits; never create merge commits; never `git stash` (shared stack).

## Test location (current phase)
- The repo-wide test relocation is DEFERRED (mobile-PWA lane ships first). Tests stay colocated beside their
  subject as `*.test.ts`, shared test helpers in a sibling `__fixtures__/`. Specs were remapped to these paths.
  Existing files under `<pkg>/test/` and `tools/scripts/test/` stay where they are.
- If a spec path still names a `test/` folder that does not exist, use the colocated equivalent and list it
  as a deviation. Do not create new `apps/*/test/` or `libs/*/test/` trees.

## Multi-unit tasks
- A task may list several unit IDs. Implement them IN THE LISTED ORDER, each as its own contiguous block of
  commits with that unit's ID in the subject, each block following the commit protocol above on its own.
- The task gate checks every block: `node /Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/tools/task-gate.cjs --units A,B --wt . --base <BASE> --round <ROUND> --key <KEY>`.
  For a single-unit task use the unit gate below.
- Size ratchet is enforced in CI: `node tools/scripts/size-budget.mjs check` must pass. Never edit
  `tools/budgets/*.json` to raise a ceiling; shrinking is allowed (the tool reports it).
- Broad vitest runs: `--maxWorkers=2` (many coders share this machine).

## Validation (real exit codes, not claims)
- Run every command in the spec's `verify` list from the worktree root; all must exit 0.
- Then run the gate yourself and iterate until it prints `"verdict":"pass"`:
  `node /Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/tools/unit-gate.cjs --unit <ID> --wt . --base <BASE> --round <ROUND>`
  It checks branch shape, ownership, characterization-first (passes on base, frozen), red-then-green
  regression, verify commands, prettier and size. Its full log path is in the output.
- If a test is flaky under load, re-run it alone to confirm before assuming your change broke it, and say so.
- Do not run e2e or packaging builds unless they are in `verify`. Never write into `release/`.

## Do not
- push, open PRs, touch other worktrees or the main checkout, change git config, install global tools.
- weaken types (`any`, `@ts-expect-error`, `@ts-nocheck`), skip tests, or loosen lint/strictness to pass.
- change IPC/RPC/status-key/protocol/schema contracts unless the spec says so.

## Final report (<= 12 lines)
`RESULT: done|BLOCKED`, commits (sha + subject), gate verdict, verify results, deviations from the spec and
why, anything the reviewer should look at closely.

## Standing supervisor decisions (no need to ask)

- **extra_gates (e2e, screenshot smoke, control-stack, startup specs):** the integrator runs them. Never run e2e
  or screenshot commands yourself. Under deviations, note "extra_gates deferred to integrator".
- **Typing/lint-only amend of the characterize commit:** pre-approved when full typecheck or lint flags the new
  frozen test. Examples: non-null assertions on `mock.calls[i]`, type-only imports instead of `typeof import()`,
  required fixture fields such as `message`. Do not change any assertion, case or test name. Rerun the
  characterization on unchanged base source, confirm it passes, and list the amend under deviations.
- **Spec path that names `.../test/...` when the colocated file exists:** use the colocated path, and say so
  under deviations. Ask only if neither exists and the intended home is unclear.
