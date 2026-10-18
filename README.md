# Remediation kit

These are the scripts and data that drove the Phosphor engineering remediation. The handoff doc is `docs/remediation.md` on main; start there.

Paths inside the scripts are hard-coded to the original scratch dir
(`/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715`). Copy this branch to that path, or replace the `S` constant in each script.

- `plans/program.json`: all 538 unit specs, including `replan` evidence from the post-PWA audit.
- `exec/state.json`: per-unit status at the time of the handoff.
- `exec/tasks.json`: how units group into coder tasks.
- `exec/PROTOCOL-*.md`: the coder and reviewer rules.
- `tools/wave-runner.js`: pi-subagents workflow that runs coder, then gate, then reviewer, per task.
- `tools/unit-gate.cjs`, `tools/task-gate.cjs`: enforce characterize-first, ownership, verify, prettier and size.
- `tools/integrate.cjs`: cherry-picks approved units into a PR worktree and runs the CI-equivalent gate.
- `tools/tighten-budgets.mjs`: ratchets size ceilings down after a PR.
- `tools/ready-tasks.cjs`: lists tasks whose dependencies are met.
- `EXECUTION.md`: the running decision log.
