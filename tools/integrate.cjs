#!/usr/bin/env node
// Integrate approved unit branches into a PR worktree, then run the CI-equivalent batch gate.
// Usage: node integrate.cjs <pr-key> <ID[:base]>... [--gate-only] [--no-gate] [--skip-test]
// A unit's base defaults to exec/state.json units[ID].base.
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const S = '/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715'
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const [key, ...ids] = argv.filter((a) => !a.startsWith('--'))
const PR = path.join(S, 'wt', `pr-${key}`)
const statePath = path.join(S, 'exec/state.json')
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { units: {} }
const LOG = path.join(S, 'exec/logs', `integrate-${key}-${Date.now()}.log`)
const log = (s) => fs.appendFileSync(LOG, s.endsWith('\n') ? s : s + '\n')
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || PR, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: opts.timeout || 40 * 60 * 1000, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
  return { status: r.status === null ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const out = { pr: key, integrated: [], failed: null, gate: [], log: LOG }
if (run('git', ['status', '--porcelain']).out.trim()) { out.failed = 'PR worktree not clean'; finish() }
if (!flags.has('--gate-only')) {
  const seenHeads = new Set()
  for (const spec of ids) {
    // ID may contain ':' (libs:title-policy); an optional base is a trailing ':<40-hex sha>'.
    const m = /^(.*?)(?::([0-9a-f]{40}))?$/.exec(spec)
    const id = m[1]
    const base = m[2] || state.units[id]?.base
    if (!base) { out.failed = `${id}: no base recorded`; finish() }
    // Head: unit/<ID> if it exists, else the HEAD of the unit's recorded task worktree.
    let head = `unit/${id}`
    if (run('git', ['rev-parse', '--verify', '-q', `refs/heads/unit/${id}`]).status !== 0) {
      const wt = state.units[id]?.wt
      if (!wt) { out.failed = `${id}: no unit branch and no worktree recorded`; finish() }
      head = run('git', ['-C', wt, 'rev-parse', 'HEAD']).out.trim()
    }
    if (seenHeads.has(head)) { out.integrated.push(`${id} (shared task head, already picked)`); state.units[id] = { ...(state.units[id] || {}), status: 'integrated', pr: key, integratedAt: new Date().toISOString() }; continue }
    seenHeads.add(head)
    const range = `${base}..${head}`
    const n = run('git', ['rev-list', '--count', range]).out.trim()
    const r = run('git', ['cherry-pick', '--allow-empty', range])
    log(`cherry-pick ${id} ${range} (${n} commits) -> ${r.status}\n${r.out}`)
    if (r.status !== 0) { run('git', ['cherry-pick', '--abort']); out.failed = `${id}: cherry-pick conflict: ${r.out.split('\n').filter((l) => /CONFLICT|error/.test(l)).slice(0, 5).join(' | ')}`; finish() }
    out.integrated.push(`${id} (${n} commits)`)
    state.units[id] = { ...(state.units[id] || {}), status: 'integrated', pr: key, integratedAt: new Date().toISOString() }
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}
if (!flags.has('--no-gate')) {
  const steps = [
    ['typecheck', 'npm run typecheck'], ['typecheck:host', 'npm run typecheck:host'], ['typecheck:control', 'npm run typecheck:control'],
    ['lint', 'npm run lint'], ['prettier', 'npx prettier --check .'],
    ...(flags.has('--skip-test') ? [] : [['test', 'npx vitest run']]),
  ]
  for (const [name, cmd] of steps) {
    const t0 = Date.now(); const r = run('/bin/sh', ['-c', cmd])
    const secs = Math.round((Date.now() - t0) / 1000)
    log(`\n=== ${name} [${r.status}] ${secs}s\n${r.out.slice(-20000)}`)
    const tail = r.status ? r.out.split('\n').filter((l) => /FAIL|error|✗|×|failed/i.test(l)).slice(0, 12).join('\n') : ''
    out.gate.push({ step: name, status: r.status, secs, tail })
  }
}
finish()
function finish() {
  out.head = run('git', ['rev-parse', '--short', 'HEAD']).out.trim()
  out.ok = !out.failed && out.gate.every((g) => g.status === 0)
  console.log(JSON.stringify(out, null, 1)); process.exit(0)
}
