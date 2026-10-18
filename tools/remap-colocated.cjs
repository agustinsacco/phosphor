#!/usr/bin/env node
// PWA-first decision (COORDINATION-PWA.md): the repo-wide test relocation is deferred
// until after the PWA deploys. Remap non-held, non-renderer units from post-relocation
// test/ paths back to today's colocated convention so they can run now.
//   node remap-colocated.cjs --plan <RL-01-plan.json> --tree <ref-in-lane> [--write]
// Rules, per path token:
//   1. exists on the tree                -> unchanged (foundation's test/ files stay)
//   2. exact RL-01 move target           -> its current source path
//   3. under a relocation test root      -> colocated beside the subject; a non-test
//      helper goes to a sibling __fixtures__/ (CLAUDE.md convention)
//   tools/scripts/test and tools/host-release/test are kept (already the tools convention).
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const S = path.resolve(__dirname, '..')
const LANE = '/Users/agustinsacco/src/agustinsacco/Phosphor/.phosphor/worktrees/id-like-you-to-review-the-state-of-this'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const write = process.argv.includes('--write')
const plan = JSON.parse(fs.readFileSync(arg('--plan'), 'utf8'))
const tree = execFileSync('git', ['-C', LANE, 'ls-tree', '-r', '--name-only', arg('--tree')], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean)
const files = new Set(tree)
const dirs = new Set()
for (const f of tree) { let d = path.posix.dirname(f); while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = path.posix.dirname(d) } }
const inverse = new Map(plan.moves.map((m) => [m.to, m.from]))
// Inverse rows, most specific first. Several candidates: choose by existence.
const ROWS = [
  ['apps/desktop/test/main/', ['apps/desktop/electron/']],
  ['apps/desktop/test/renderer/', ['apps/desktop/src/']],
  ['apps/desktop/test/scripts/', ['apps/desktop/scripts/']],
  ['apps/host/test/scripts/', ['apps/host/scripts/', 'apps/host/src/scripts/']],
  ['apps/host/test/', ['apps/host/src/']],
  ['apps/control/test/scripts/', ['apps/control/scripts/', 'apps/control/src/scripts/']],
  ['apps/control/test/', ['apps/control/src/']],
  ['libs/shared/test/', ['libs/shared/src/']],
  ['libs/session-runtime/test/', ['libs/session-runtime/src/']],
  ['libs/pi-extensions/test/', ['libs/pi-extensions/pi-ext/']],
]
const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /\*\.test/.test(p)
// a/b.test.ts -> a/b.ts ; a/b.race.test.ts -> a/b.race.ts or a/b.ts (+ tsx variants)
const subjects = (p) => {
  const m = /^(.*)\.(?:test|spec)\.([cm]?[jt]sx?)$/.exec(p)
  if (!m) return [p]
  const stems = [m[1], m[1].replace(/\.[\w-]+$/, '')]
  return stems.flatMap((s) => ['ts', 'tsx', 'mjs', 'cjs', 'js'].map((e) => `${s}.${e}`))
}
function remapPath(p) {
  const bare = p.replace(/[/]+$/, '')
  if (files.has(bare) || dirs.has(bare)) return p
  if (inverse.has(bare)) return inverse.get(bare)
  const row = ROWS.find(([to]) => bare.startsWith(to) || bare + '/' === to)
  if (!row) return p
  const rest = bare.length >= row[0].length ? bare.slice(row[0].length) : ''
  const cands = row[1].map((from) => from + rest)
  const pick = (c) => {
    if (!rest) return c.replace(/\/$/, '')
    if (isTest(c)) return c
    if (/\.[cm]?[jt]sx?$/.test(c) && !c.includes('__fixtures__')) {
      // Non-test helper beside tests: sibling __fixtures__/ unless it shadows a source file.
      return files.has(c) ? c : path.posix.join(path.posix.dirname(c), '__fixtures__', path.posix.basename(c))
    }
    return c
  }
  const chosen =
    cands.find((c) => files.has(c) || subjects(c).some((x) => files.has(x))) ||
    cands.find((c) => dirs.has(path.posix.dirname(c)) || dirs.has(c)) ||
    cands[0]
  return pick(chosen)
}
const TOKEN = /(?<![\w@/.-])((?:apps|libs)\/[A-Za-z0-9_.@*{},\-/]+)/g
function remapString(s, log) {
  return s.replace(TOKEN, (tok) => {
    const trail = /[.,;:)]+$/.exec(tok)?.[0] ?? ''
    const core = trail ? tok.slice(0, -trail.length) : tok
    const out = remapPath(core)
    if (out !== core) log.push(`${core} -> ${out}`)
    return out + trail
  })
}
function deep(v, log) {
  if (typeof v === 'string') return remapString(v, log)
  if (Array.isArray(v)) return v.map((x) => deep(x, log))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' || k === 'pr' ? x : deep(x, log)]))
  return v
}
const program = JSON.parse(fs.readFileSync(`${S}/plans/program.json`, 'utf8'))
const state = JSON.parse(fs.readFileSync(`${S}/exec/state.json`, 'utf8'))
const ids = new Set((arg('--units') || '').split(',').filter(Boolean))
const report = {}
for (let i = 0; i < program.units.length; i++) {
  const u = program.units[i]
  if (!ids.has(u.id)) continue
  const log = []
  const next = deep(u, log)
  next.depends_on = (next.depends_on || []).filter((d) => d !== 'reloc')
  next.colocated = { from: 'pwa-first-reloc-deferred', remapped: log.length }
  const collide = next.owns.filter((o, j) => next.owns.indexOf(o) !== j)
  if (collide.length) throw new Error(`${u.id}: duplicate owns after remap ${collide}`)
  report[u.id] = log
  if (write) {
    program.units[i] = next
    fs.writeFileSync(`${S}/exec/units/${u.id}.json`, JSON.stringify(next, null, 2))
    state.units[u.id] = Object.assign(state.units[u.id] || {}, { colocated: true })
  }
}
if (write) {
  fs.writeFileSync(`${S}/plans/program.json`, JSON.stringify(program, null, 1))
  fs.writeFileSync(`${S}/exec/state.json`, JSON.stringify(state, null, 2))
}
console.log(JSON.stringify(report, null, 1))
