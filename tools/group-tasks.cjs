// Group remaining units into one coder task per primary source file (same PR), in dependency order,
// and assign a review tier. Output: exec/tasks.json
const fs = require('fs')
const p = require('../plans/program.json'), st = require('../exec/state.json').units
const done = new Set(Object.entries(st).filter(([, v]) => ['approved', 'integrated', 'merged'].includes(v.status)).map(([k]) => k))
const SHARP = /stores\/sessions\.ts|session-writer|mac-installer|worktree-paths|tool-name-guard|artifact-protocol|file-protocol|preload|ipc\/handle\.ts|vault|identity/
const MOVE = new Set(['decompose', 'dedupe-extract', 'dedupe-adopt', 'dead-code', 'docs', 'tests', 'lint'])
const tier = (u) => !MOVE.has(u.kind) || u.contract || u.owns.some((f) => SHARP.test(f)) ? 'opus-xhigh' : u.risk === 'high' ? 'opus-high' : 'sol'
const rank = { sol: 0, 'opus-high': 1, 'opus-xhigh': 2 }
const rest = p.units.filter((u) => !done.has(u.id))
const groups = new Map()
for (const u of rest) {
  const f = u.owns.find((f) => !/\.test\.|\/test\/|__fixtures__|docs\/|\.md$/.test(f)) || u.id
  const key = `${u.pr || u.prKey}::${f}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(u)
}
const order = new Map(p.units.map((u, i) => [u.id, i]))
const tasks = [...groups.entries()].map(([key, us]) => {
  us.sort((a, b) => order.get(a.id) - order.get(b.id))
  const t = us.map(tier).reduce((a, b) => (rank[b] > rank[a] ? b : a))
  return { key, pr: key.split('::')[0], units: us.map((u) => u.id), review: t, coder: us.some((u) => u.coder === 'opus') ? 'opus' : 'sol' }
})
fs.writeFileSync(require('path').join(__dirname, '../exec/tasks.json'), JSON.stringify(tasks, null, 1))
const c = (k) => tasks.filter((t) => t.review === k).length
console.log('units', rest.length, 'tasks', tasks.length, 'review sol', c('sol'), 'opus-high', c('opus-high'), 'opus-xhigh', c('opus-xhigh'))
