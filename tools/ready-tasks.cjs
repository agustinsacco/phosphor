#!/usr/bin/env node
// List tasks whose units can be dispatched now: not held, not done/in-flight, every
// unit dependency approved/merged (or earlier in the same task), PR-level deps met.
// Usage: node ready-tasks.cjs [--pr host] [--json]
const S = require('path').resolve(__dirname, '..')
const p = require(`${S}/plans/program.json`)
const st = require(`${S}/exec/state.json`).units
const t = require(`${S}/exec/tasks.json`)
const tasks = Array.isArray(t) ? t : t.tasks
const byId = Object.fromEntries(p.units.map((u) => [u.id, u]))
const DONE = /^(merged|approved|integrated)$/
const status = (id) => (st[id] || {}).status || 'todo'
const done = (id) => DONE.test(status(id))
const prDone = (pr) => p.units.filter((u) => u.pr === pr).every((u) => done(u.id))
// fixes:X8 -> the FX unit whose findings include X8
const fixFor = {}
for (const u of p.units) if (u.pr === 'fixes') for (const f of u.findings || []) fixFor[f.replace(/^.*?([DX]\d+)$/, '$1')] = u.id
function depOk(d, task) {
  if (byId[d]) return done(d) || task.units.indexOf(d) >= 0
  if (d === 'foundation') return true
  if (d === 'reloc') return false
  const m = /^fixes:(\w+)$/.exec(d)
  if (m) return fixFor[m[1]] ? done(fixFor[m[1]]) : true
  return prDone(d)
}
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const onlyPr = arg('--pr')
const ready = []
const blocked = {}
for (const task of tasks) {
  if (onlyPr && task.pr !== onlyPr) continue
  if (task.units.every(done)) continue
  if (task.units.some((id) => status(id) !== 'todo' && !done(id))) { (blocked[task.pr] ||= {}).inflightOrHeld = ((blocked[task.pr] || {}).inflightOrHeld || 0) + 1; continue }
  const bad = task.units.flatMap((id) => (byId[id].depends_on || []).filter((d) => !depOk(d, task)))
  if (bad.length) { const b = (blocked[task.pr] ||= {}); b.deps = (b.deps || 0) + 1; continue }
  ready.push(task)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(ready))
else {
  const n = {}
  for (const r of ready) n[r.pr] = (n[r.pr] || 0) + 1
  console.log('ready', n, 'blocked', blocked)
}
