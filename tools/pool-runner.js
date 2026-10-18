// Run args.tasks ([{key, agent, model, task, cwd?}]) with at most args.concurrency at once.
const tasks = args.tasks;
const LIMIT = args.concurrency || 4;
const results = [];
let next = 0;
function lane() {
  if (next >= tasks.length) return Promise.resolve();
  const t = tasks[next++];
  return runs
    .run(t.key, { agent: t.agent, model: t.model, cwd: t.cwd || args.cwd, timeoutMs: 120 * 60 * 1000, task: t.task })
    .then(
      (r) => { results.push({ key: t.key, runId: r.runId, error: r.error || null }); },
      (e) => { results.push({ key: t.key, error: String(e).slice(0, 400) }); },
    )
    .then(lane);
}
const lanes = [];
for (let i = 0; i < Math.min(LIMIT, tasks.length); i++) lanes.push(lane());
await Promise.all(lanes);
return results;
