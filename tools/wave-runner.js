const S = "/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715";
const M = {
  sol: "openai-codex/gpt-6.1-sol:high",
  opus: "pi-claude-cli/claude-opus-5-5:xhigh",
  "opus-high": "pi-claude-cli/claude-opus-5-5:high",
  "opus-xhigh": "pi-claude-cli/claude-opus-5-5:xhigh",
};
const tasks = args.tasks.map((t) => ({
  ...t,
  base: t.base || args.base,
  extra: t.extra || args.extra,
  wt: t.wt || `${S}/wt/t-${t.units[0].replace(/:/g, "-")}`,
}));
const LIMIT = args.concurrency || 3;
function safe(s) { return s.replace(/[^A-Za-z0-9_-]/g, "-"); }
function gateCmd(t, wt) {
  const r = t.round || 1;
  if (t.units.length === 1) return `node ${S}/tools/unit-gate.cjs --unit ${t.units[0]} --wt ${wt} --base ${t.base} --round ${r}`;
  return `node ${S}/tools/task-gate.cjs --units ${t.units.join(",")} --wt ${wt} --base ${t.base} --round ${r} --key ${safe(t.units.join("+"))}`;
}
function review(t, id, key, r, specs, w) {
  const g = w.structuredOutput || null;
  if (!g || g.verdict !== "pass")
    return { id, stage: "gate", failures: g ? (g.failures || []).slice(0, 4) : null, coderRun: w.runId, error: w.error || null };
  const out = `${S}/exec/reviews/${key}.r${r}.md`;
  return runs.run(`review-${key}-r${r}`, {
    agent: "reviewer", model: M[t.review], cwd: t.wt, output: out, timeoutMs: 60 * 60 * 1000,
    task: [
      `Review remediation task ${id} (round ${r}); units in order: ${t.units.join(", ")}. You are read-only.`,
      `1. Read the reviewer protocol: ${S}/exec/PROTOCOL-REVIEWER.md (acceptance-report rules at the end: commandsRun never empty, no extra keys).`,
      `2. Read the review packet: ${g.packet}. Read it fully (and each unit packet it links), using offsets if long.`,
      `3. Unit specs: ${specs}. Read surrounding code in the worktree (your cwd) and the gate log as needed.`,
      `End your answer with the json verdict block AND the two plain trailer lines (VERDICT:, BLOCKING:) the protocol specifies.`,
    ].join("\n"),
    gate: { command: `node ${S}/tools/read-verdict.cjs ${out}`, output: "json" },
  }).then((rv) => {
    const v = rv.structuredOutput || {};
    return { id, stage: "review", verdict: v.verdict || null, blocking: v.blocking, minor: v.minor, top: (v.top || []).slice(0, 2), coderRun: w.runId, reviewRun: rv.runId, error: rv.error || null };
   }, (e) => ({ id, stage: "review-error", error: String(e).slice(0, 400), file: out }));
}
function one(t) {
  const r = t.round || 1;
  const id = t.units.join("+");
  const key = safe(id);
  const specs = t.units.map((u) => `${S}/exec/units/${u}.json`).join(", ");
  return runs.run(`code-${key}-r${r}`, {
    agent: "worker", model: M[t.coder], cwd: t.wt, timeoutMs: 150 * 60 * 1000,
    task: [
      `Implement remediation task ${id} (round ${r}); units in order: ${t.units.join(", ")}.`,
      `Worktree (your cwd): ${t.wt}`,
      `BASE sha: ${t.base}`,
      `1. Read the coder protocol: ${S}/exec/PROTOCOL-CODER.md (mandatory rules; note "Test location" and "Multi-unit tasks").`,
      `2. Read the unit spec(s): ${specs}`,
      `3. Integrator notes: Base is the BASE sha above (current main). The CI size ratchet is enforced, so any growth of an already-baselined file/function fails. Tests stay colocated. The renderer now lives in libs/client-ui (shared with apps/web); touch libs/client-ui, libs/host-client or apps/web only where the spec owns it. Read the "Standing supervisor decisions" section of the protocol before asking anything. For a test-only split, the characterize commit may be a frozen inventory comment (case count, full names in the commit body) after running every case on base; prove inventory parity before/after with npx vitest list (diff: none). If a moved case's size-budget key changes, carry the existing ceiling unchanged via the budget file's renames (own commit, minimal diff) and say so. ${t.extra || ""}`,
      `Gate command (run it yourself until it passes): ${gateCmd(t, ".")}`,
      `Finish with the protocol's final report.`,
    ].join("\n"),
    gate: { command: gateCmd(t, t.wt), output: "json", timeoutMs: 60 * 60 * 1000 },
  }).then((w) => review(t, id, key, r, specs, w));
}
const results = [];
let next = 0;
function lane() {
  if (next >= tasks.length) return Promise.resolve();
  const t = tasks[next++];
  return one(t)
    .then((res) => { results.push(res); }, (e) => { results.push({ id: t.units.join("+"), stage: "crash", error: String(e).slice(0, 400) }); })
    .then(lane);
}
const lanes = [];
for (let i = 0; i < Math.min(LIMIT, tasks.length); i++) lanes.push(lane());
await Promise.all(lanes);
return results;
