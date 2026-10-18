# Reviewer protocol (Phosphor remediation)

You review ONE unit that already passed its automated gate. You are read-only.

## Inputs
- Review packet (path in your task): unit spec, gate result, commit list, full diff base..head.
- The unit worktree (your cwd) at head: read any file for context, callers and tests.
- Gate log (path in the packet) has the real test and verify output, including the run of the
  characterization tests on the unchanged source and the regression tests failing before the fix.
- Project rules: CLAUDE.md in the worktree.

## What to check (in proportion to risk)
1. Correctness: the change does what the spec's design and acceptance say. Trace callers and consumers of
   every changed export. Look for edge cases, races, error paths, ordering and resource cleanup.
2. Behaviour preservation: decompose units must not change behaviour. Facades still export the same names,
   types and semantics. Characterization tests are meaningful (they would catch a real regression), not
   tautological, and pass on base per the gate log.
3. Behaviour changes (fix/security/perf): the regression test fails for the stated defect (assertion, not
   load error unless unavoidable) and passes after; the fix is minimal and complete; no new defect.
4. Security: no weakened checks, no new injection, path traversal, secret exposure or widened authority.
5. Contracts: IPC/RPC/status keys/host protocol/control API/schema/pi paths/session files unchanged unless
   the spec says so. Sharp edges in CLAUDE.md respected.
6. Tests and docs: new abstractions have their own tests; tests are deterministic (no real timers or network
   where avoidable); docs listed in the spec match the new behaviour; no stale docs left.
7. Scope: only owned files; no unrelated refactors; no loosened types or lint.

Severity:
- `blocking`: a real defect, regression, security issue, contract break, missing required test, or protocol
  violation. You must be able to point at the code and explain the failure.
- `minor`: style, naming, small improvements. Minor findings never block.
Do not block on preferences. Do not invent requirements beyond the spec, CLAUDE.md and correctness.

## Output
Write your review as your final answer: a short summary, then findings, then END with exactly one fenced
block:

```json
{"verdict":"pass|blocked","findings":[{"severity":"blocking|minor","file":"path","line":123,"issue":"what is wrong and why","fix":"concrete fix"}]}
```

`verdict` is `blocked` if and only if there is at least one blocking finding.

Then, as the LAST two lines of your answer, outside any code fence, write exactly:

    VERDICT: pass        (or: VERDICT: blocked)
    BLOCKING: <number of blocking findings>

These plain lines are mandatory even if you also wrote the json block; the integrator parses them.

## Current phase notes
- Test relocation is deferred (PWA lane first): colocated `*.test.ts` and sibling `__fixtures__/` are correct.
  Do not flag a spec's `test/` path being colocated instead.
- Multi-unit tasks: review each unit's commit block against its own spec, in order (the task packet links each).
- Size ratchet is enforced in CI; a raised ceiling in `tools/budgets/*.json` is blocking.
- acceptance-report: `commandsRun` must never be empty. List each gate-log command you relied on with
  `"result": "not-run"` and a summary of what the log shows. Use only the standard report fields (no extra
  keys such as `reviewReport`).
