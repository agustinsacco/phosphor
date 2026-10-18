#!/usr/bin/env node
// Gate a multi-unit task branch: commits must form contiguous per-unit blocks in the
// given order (subjects "<type>(<ID>): ..."). Each block is gated by unit-gate.cjs with
// --base <previous block end> --head <block end>; verify for the last block runs at HEAD.
// Usage: node task-gate.cjs --units A,B,C --wt <worktree> --base <sha> [--round N] [--key name]
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const S = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const units = (arg('units', '') || '').split(',').filter(Boolean)
const WT = arg('wt'), BASE = arg('base'), ROUND = arg('round', '1')
const key = arg('key', units.join('+'))
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0) }
const git = (...a) => spawnSync('git', ['-C', WT, ...a], { encoding: 'utf8' }).stdout.trim()
if (!units.length || !WT || !BASE) out({ verdict: 'fail', failures: ['usage: --units --wt --base'] })

const commits = git('rev-list', '--reverse', `${BASE}..HEAD`).split('\n').filter(Boolean)
  .map((sha) => ({ sha, subject: git('log', '-1', '--format=%s', sha) }))
const idOf = (s) => (/^[a-z]+\(([^)]+)\): /.exec(s) || [])[1]
const failures = []
const blocks = []
for (const c of commits) {
  const id = idOf(c.subject)
  if (!units.includes(id)) { failures.push(`commit not owned by a task unit: ${c.subject}`); continue }
  const last = blocks.at(-1)
  if (last && last.id === id) last.end = c.sha
  else {
    if (blocks.some((b) => b.id === id)) failures.push(`unit ${id} commits are not contiguous`)
    blocks.push({ id, end: c.sha })
  }
}
const order = blocks.map((b) => b.id)
if (JSON.stringify(order) !== JSON.stringify(units.filter((u) => order.includes(u))))
  failures.push(`unit blocks out of order: ${order.join(',')} (expected ${units.join(',')})`)
const missing = units.filter((u) => !order.includes(u))
if (missing.length) failures.push(`units with no commits: ${missing.join(', ')}`)
if (failures.length) out({ verdict: 'fail', failures, warnings: [], evidence: [] })

const results = []
let base = BASE
for (const [i, b] of blocks.entries()) {
  const args = [path.join(__dirname, 'unit-gate.cjs'), '--unit', b.id, '--wt', WT, '--base', base, '--round', ROUND]
  if (i < blocks.length - 1) args.push('--head', b.end)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  let j
  try { j = JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { j = { verdict: 'fail', failures: [`unit-gate crashed for ${b.id}: ${r.stderr.slice(-800)}`] } }
  results.push({ id: b.id, base, head: b.end, ...j })
  base = b.end
}
const verdict = results.every((r) => r.verdict === 'pass') ? 'pass' : 'fail'
const dir = path.join(S, 'exec/packets'); fs.mkdirSync(dir, { recursive: true })
const packet = path.join(dir, `task-${key}.r${ROUND}.md`)
fs.writeFileSync(packet, [`# Task packet ${key} round ${ROUND}`, `Units in order: ${units.join(', ')}. Worktree: ${WT}. Base: ${BASE}.`,
  'Review every unit packet below in order; each covers only its own commit block.',
  ...results.map((r) => `- ${r.id}: verdict ${r.verdict}, base ${r.base.slice(0, 10)}, head ${r.head.slice(0, 10)}, packet ${r.packet || '(none)'}${r.failures?.length ? `\n  failures: ${r.failures.join(' | ').slice(0, 1500)}` : ''}`)].join('\n\n'))
out({
  verdict,
  failures: results.flatMap((r) => (r.failures || []).map((f) => `${r.id}: ${f}`)),
  warnings: results.flatMap((r) => (r.warnings || []).map((f) => `${r.id}: ${f}`)),
  evidence: results.flatMap((r) => (r.evidence || []).slice(0, 6).map((f) => `${r.id}: ${f}`)),
  units: results.map((r) => ({ id: r.id, verdict: r.verdict, head: r.head, packet: r.packet })),
  packet,
})
