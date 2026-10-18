#!/usr/bin/env node
// Unit gate: proves a unit branch follows the protocol, using real exit codes.
// Usage: node unit-gate.cjs --unit <ID> --wt <worktree> --base <sha> [--round N] [--skip-verify] [--extra-owns a,b]
// Prints one JSON document: { unit, verdict: "pass"|"blocked", failures[], warnings[], log, packet }.
// Always exits 0 so the verdict, not the exit code, carries the result.
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const S = '/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715'
const REPO = '/Users/agustinsacco/src/agustinsacco/Phosphor/.phosphor/worktrees/id-like-you-to-review-the-state-of-this'
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1] }
const flag = (k) => argv.includes(`--${k}`)
const ID = arg('unit'); const WT = path.resolve(arg('wt', '.')); const BASE = arg('base'); const ROUND = arg('round', '1')
const LOGDIR = path.join(S, 'exec/logs'); fs.mkdirSync(LOGDIR, { recursive: true })
const LOG = path.join(LOGDIR, `${ID}.r${ROUND}.gate.log`)
fs.writeFileSync(LOG, `gate ${ID} round ${ROUND} wt=${WT} base=${BASE} ${new Date().toISOString()}\n`)
const log = (s) => fs.appendFileSync(LOG, s.endsWith('\n') ? s : s + '\n')
const failures = []; const warnings = []; const evidence = []
const done = () => {
  const verdict = failures.length ? 'blocked' : 'pass'
  log(`\nVERDICT ${verdict}\nfailures:\n- ${failures.join('\n- ')}\nwarnings:\n- ${warnings.join('\n- ')}`)
  let packet = null
  try { packet = writePacket(verdict) } catch (e) { warnings.push(`packet: ${e.message}`) }
  const out = { unit: ID, round: Number(ROUND), verdict, failures: failures.map((f) => f.slice(0, 600)), warnings: warnings.map((w) => w.slice(0, 300)), evidence, log: LOG, packet }
  let s = JSON.stringify(out)
  if (s.length > 11000) { out.failures = out.failures.slice(0, 8); out.warnings = out.warnings.slice(0, 8); out.evidence = out.evidence.slice(0, 10); s = JSON.stringify(out).slice(0, 11500) }
  process.stdout.write(s + '\n'); process.exit(0)
}
process.on('uncaughtException', (e) => { failures.push(`gate crashed: ${e.stack || e}`); done() })

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || WT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: opts.timeout || 30 * 60 * 1000, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(opts.env || {}) } })
  return { status: r.status === null ? (r.signal ? 128 : 1) : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, signal: r.signal, error: r.error }
}
function git(...a) {
  const r = run('git', ['-C', WT, ...a])
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.out.slice(0, 500)}`)
  return r.out
}
const sh = (cmd, cwd, timeout) => run('/bin/sh', ['-c', cmd], { cwd, timeout })

if (!ID || !BASE) { failures.push('usage: --unit and --base are required'); done() }
const program = JSON.parse(fs.readFileSync(arg('program', path.join(S, 'plans/program.json')), 'utf8'))
const unit = program.units.find((u) => u.id === ID)
if (!unit) { failures.push(`unknown unit ${ID}`); done() }
const extraOwns = (arg('extra-owns', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const BEHAVIOUR = ['fix', 'security', 'perf'].includes(unit.kind)
const isTest = (f) => /(^|\/)(__tests__|__fixtures__|test|tests|e2e)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /\.test-d\.ts$/.test(f)
const isVitestFile = (f) => /\.test\.[cm]?[jt]sx?$/.test(f) && !/(^|\/)e2e\//.test(f)
const reId = ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------- 1. Branch shape ----------
// --head <sha> checks one unit inside a multi-unit task branch (base..head only).
const head = git('rev-parse', arg('head', 'HEAD')).trim()
const AT_WT = head === git('rev-parse', 'HEAD').trim()
evidence.push(`head ${head.slice(0, 12)} base ${BASE.slice(0, 12)}`)
if (run('git', ['-C', WT, 'merge-base', '--is-ancestor', BASE, head]).status !== 0) failures.push('base is not an ancestor of HEAD')
const dirty = git('status', '--porcelain', '--untracked-files=all').trim()
if (dirty) failures.push(`worktree not clean (uncommitted or untracked files):\n${dirty.split('\n').slice(0, 15).join('\n')}`)
const commits = git('rev-list', '--reverse', `${BASE}..${head}`).trim().split('\n').filter(Boolean)
if (!commits.length) { failures.push('no commits on unit branch'); done() }
const subj = (c) => git('log', '-1', '--format=%s', c).trim()
const filesOf = (c) => git('diff-tree', '--no-commit-id', '--name-only', '-r', '-M', c).trim().split('\n').filter(Boolean)
const C = commits.map((c) => ({ sha: c, subject: subj(c), files: filesOf(c) }))
for (const c of C) {
  log(`commit ${c.sha.slice(0, 10)} ${c.subject}\n  ${c.files.join('\n  ')}`)
  if (!new RegExp(`^[a-z]+\\(${reId}\\): \\S`).test(c.subject)) failures.push(`commit subject must be "<type>(${ID}): ...": ${c.subject}`)
}
const merges = git('rev-list', '--merges', `${BASE}..${head}`).trim()
if (merges) failures.push('merge commits on unit branch; rebase instead')

// ---------- 2. Ownership ----------
const ownPatterns = [...unit.owns, ...extraOwns].map((o) => o.replace(/\s*\(.*\)\s*$/, '').trim()).filter((o) => o && !/\s/.test(o))
const toRe = (p) => new RegExp('^' + p.split('**').map((s) => s.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + (p.endsWith('/') ? '.*' : '') + '$')
const ownRes = ownPatterns.map(toRe)
const nameStatus = git('diff', '--name-status', '-M', BASE, head).trim().split('\n').filter(Boolean)
const changed = []
for (const line of nameStatus) {
  const parts = line.split('\t'); const st = parts[0]
  for (const f of parts.slice(1)) changed.push({ st, f })
}
for (const { st, f } of changed) if (!ownRes.some((r) => r.test(f))) failures.push(`outside owns: ${st} ${f}`)
evidence.push(`changed ${changed.length} paths`)

// ---------- helpers to run tests at a commit ----------
const TMP = path.join(S, 'wt', `gate-${ID.replace(/[^A-Za-z0-9._-]/g, '-')}`)
function checkoutTmp(sha) {
  if (!fs.existsSync(path.join(TMP, '.git'))) {
    const r = run('git', ['-C', REPO, 'worktree', 'add', '--detach', '--force', TMP, sha])
    if (r.status !== 0) throw new Error(`tmp worktree: ${r.out}`)
  } else {
    const r = run('git', ['-C', TMP, 'checkout', '-q', '--detach', '-f', sha])
    if (r.status !== 0) throw new Error(`tmp checkout: ${r.out}`)
    run('git', ['-C', TMP, 'clean', '-fdq', '-e', 'node_modules'])
  }
  for (const d of ['node_modules', 'apps/desktop/node_modules', 'apps/control/node_modules', 'apps/site/node_modules']) {
    if (!fs.existsSync(path.join(TMP, d)) && fs.existsSync(path.join(WT, d))) {
      fs.mkdirSync(path.dirname(path.join(TMP, d)), { recursive: true })
      const r = run('cp', ['-cR', path.join(WT, d), path.join(TMP, d)])
      if (r.status !== 0) throw new Error(`clone ${d}: ${r.out}`)
    }
  }
}
function vitestAt(sha, files, label) {
  checkoutTmp(sha)
  const report = path.join(LOGDIR, `${ID}.r${ROUND}.${label}.json`)
  const r = run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...files], { cwd: TMP, timeout: 20 * 60 * 1000 })
  let j = null
  try { j = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* load error */ }
  const sum = j ? { passed: j.numPassedTests, failed: j.numFailedTests, suitesFailed: j.numFailedTestSuites, total: j.numTotalTests } : null
  const failedNames = j ? j.testResults.flatMap((t) => (t.assertionResults || []).filter((a) => a.status === 'failed').map((a) => `${path.basename(t.name)} › ${a.fullName}`)) : []
  const suiteErrors = j ? j.testResults.filter((t) => t.status === 'failed' && !(t.assertionResults || []).some((a) => a.status === 'failed')).map((t) => `${path.basename(t.name)}: ${(t.message || '').split('\n')[0].slice(0, 200)}`) : []
  log(`\n--- vitest @${sha.slice(0, 10)} [${label}] status=${r.status} ${JSON.stringify(sum)}\n${r.out.slice(-6000)}`)
  return { status: r.status, sum, failedNames, suiteErrors, noFiles: /No test files found/.test(r.out) }
}

// ---------- 3. Characterization-first ----------
const charFiles = (unit.characterize_first || []).map((c) => c.test).filter(Boolean)
let c0 = null
if (charFiles.length) {
  c0 = C[0]
  if (!new RegExp(`^test\\(${reId}\\): characteri[sz]`).test(c0.subject)) failures.push(`first commit must be "test(${ID}): characterize ..." (unit lists characterize_first)`)
  const nonTest = c0.files.filter((f) => !isTest(f))
  if (nonTest.length) failures.push(`characterization commit touches non-test files: ${nonTest.join(', ')}`)
  const missing = charFiles.filter((f) => !c0.files.includes(f))
  if (missing.length) warnings.push(`characterization commit does not touch listed files: ${missing.join(', ')}`)
  const vfiles = c0.files.filter(isVitestFile)
  if (vfiles.length) {
    const r = vitestAt(c0.sha, vfiles, 'characterize')
    if (r.noFiles || r.status !== 0 || !r.sum || r.sum.failed > 0 || r.sum.passed === 0) failures.push(`characterization tests must pass on unchanged source: status=${r.status} ${JSON.stringify(r.sum)} ${[...r.failedNames, ...r.suiteErrors].slice(0, 5).join(' | ')}`)
    else evidence.push(`characterization green on base: ${r.sum.passed} tests in ${vfiles.length} files`)
  } else if (!c0.files.some((f) => /\.spec\.ts$/.test(f))) failures.push('characterization commit has no runnable test files')
  // Frozen: no line added by c0 may be deleted later.
  for (const f of c0.files.filter(isTest)) {
    const added = new Set(git('show', '--format=', '--unified=0', c0.sha, '--', f).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((t) => t.length > 3 && !/^[})\];,]+$/.test(t)))
    if (!added.size) continue
    const later = run('git', ['-C', WT, 'diff', '--unified=0', c0.sha, head, '--', f]).out
    const removed = later.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim()).filter((t) => added.has(t))
    if (removed.length) failures.push(`characterization lines edited after first commit in ${f}: ${removed.slice(0, 3).join(' ⏎ ')}`)
  }
}

// ---------- 4. Red-then-green regression for behaviour changes ----------
if (BEHAVIOUR) {
  const ri = C.findIndex((c) => new RegExp(`^test\\(${reId}\\): regression`).test(c.subject))
  if (ri < 0) failures.push(`${unit.kind} unit needs a "test(${ID}): regression ..." commit whose tests fail before the change`)
  else {
    const before = C.slice(0, ri + 1).filter((c) => c.files.some((f) => !isTest(f)))
    if (before.length) failures.push(`source changed before or in the regression commit: ${before.map((c) => c.subject).join('; ')}`)
    // Every regression commit (later review rounds add more) must be test-only and red at its own commit.
    C.forEach((reg, i) => {
      if (!new RegExp(`^test\\(${reId}\\): regression`).test(reg.subject)) return
      const tag = `regression-red-${i}`
      if (reg.files.some((f) => !isTest(f))) failures.push(`regression commit changes source: ${reg.subject}`)
      const vfiles = reg.files.filter(isVitestFile)
      if (!vfiles.length) { failures.push(`regression commit has no vitest test files: ${reg.subject}`); return }
      const r = vitestAt(reg.sha, vfiles, tag)
      if (r.noFiles) failures.push(`regression run found no test files: ${reg.subject}`)
      else if (r.status === 0) failures.push(`regression tests PASS before the fix; they do not demonstrate the defect: ${reg.subject}`)
      else {
        const kind = r.failedNames.length ? 'assertion' : 'load-error'
        evidence.push(`regression red before fix (${kind}) [${reg.subject.slice(0, 60)}]: ${[...r.failedNames, ...r.suiteErrors].slice(0, 6).join(' | ')}`)
        if (kind === 'load-error') warnings.push(`regression is red only by suite load error (${r.suiteErrors.slice(0, 2).join(' | ')}); reviewer must judge`)
      }
    })
  }
}

// ---------- 5. Verify commands at HEAD ----------
if (!flag('skip-verify')) {
  for (const cmd of unit.verify) {
    if (!AT_WT) checkoutTmp(head)
    const t0 = Date.now(); const r = sh(cmd, AT_WT ? WT : TMP, 30 * 60 * 1000)
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    log(`\n--- verify [${r.status}] (${secs}s) ${cmd}\n${r.out.slice(-8000)}`)
    if (r.status !== 0) failures.push(`verify failed (exit ${r.status}): ${cmd}\n${r.out.split('\n').filter((l) => /error|fail|✗|×/i.test(l)).slice(0, 8).join('\n')}`)
    else evidence.push(`verify ok (${secs}s): ${cmd.slice(0, 120)}`)
  }
}

// ---------- 5b. Root config changes run the whole suite ----------
// A root package.json/tsconfig/vitest/eslint change can break any suite (FD-04
// changed the root typecheck script and missed apps/desktop/package-boundary.test.ts).
const ROOT_CONFIG = /^(package\.json|package-lock\.json|vitest\.config\.ts|eslint\.config\.js|tsconfig[^/]*\.json|apps\/[^/]+\/(package\.json|tsconfig[^/]*\.json))$/
const KNOWN_FLAKES = [/setup\.test\.ts › .*64 KiB/, /hydrationScale\.test\.ts › .*scales linearly/, /run\.test\.ts › /]
const rootTouched = changed.map(({ f }) => f).filter((f) => ROOT_CONFIG.test(f))
if (rootTouched.length && !flag('skip-verify')) {
  const report = path.join(LOGDIR, `${ID}.r${ROUND}.full.json`)
  const t0 = Date.now()
  const r = run('npx', ['vitest', 'run', '--maxWorkers=2', '--reporter=json', `--outputFile=${report}`], { cwd: (AT_WT ? WT : (checkoutTmp(head), TMP)), timeout: 40 * 60 * 1000 })
  let j = null
  try { j = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* load error */ }
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  log(`\n--- full vitest (root config: ${rootTouched.join(', ')}) status=${r.status} (${secs}s)\n${r.out.slice(-4000)}`)
  if (!j) failures.push(`full vitest produced no report (root config changed: ${rootTouched.join(', ')})`)
  else {
    const failed = j.testResults.flatMap((t) => (t.assertionResults || []).filter((a) => a.status === 'failed').map((a) => `${path.basename(t.name)} › ${a.fullName}`))
    const suiteErr = j.testResults.filter((t) => t.status === 'failed' && !(t.assertionResults || []).some((a) => a.status === 'failed')).map((t) => `${path.basename(t.name)}: suite failed`)
    const real = [...failed.filter((n) => !KNOWN_FLAKES.some((k) => k.test(n))), ...suiteErr]
    const flaky = failed.filter((n) => KNOWN_FLAKES.some((k) => k.test(n)))
    if (real.length) failures.push(`full vitest failed after root config change: ${real.slice(0, 8).join(' | ')}`)
    else evidence.push(`full vitest ok (${secs}s, ${j.numPassedTests} passed) after root config change`)
    if (flaky.length) warnings.push(`known load flakes failed in full run: ${flaky.join(' | ')}`)
  }
}

// ---------- 6. Formatting and size ----------
const SRC = AT_WT ? WT : (checkoutTmp(head), TMP)
const existing = changed.filter(({ st }) => !st.startsWith('D')).map(({ f }) => f).filter((f) => fs.existsSync(path.join(SRC, f)))
if (existing.length) {
  const r = run('npx', ['prettier', '--check', '--ignore-unknown', ...existing], { cwd: SRC })
  log(`\n--- prettier [${r.status}]\n${r.out.slice(-3000)}`)
  if (r.status !== 0) failures.push(`prettier --check failed: ${r.out.split('\n').filter((l) => /\[warn\]/.test(l)).slice(0, 8).join(' ')}`)
}
for (const f of existing.filter((x) => /\.(ts|tsx|mjs|cjs|js)$/.test(x) && !isTest(x) && !/\.d\.ts$/.test(x))) {
  const now = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').length
  const b = run('git', ['-C', WT, 'show', `${BASE}:${f}`])
  const was = b.status === 0 ? b.out.split('\n').length : 0
  if (now > 400 && was === 0) failures.push(`new source file over 400 lines: ${f} (${now})`)
  else if (now > 400 && was <= 400) failures.push(`source file crossed 400 lines: ${f} (${was} -> ${now})`)
  else if (now > 400 && now > was) warnings.push(`oversized file grew: ${f} (${was} -> ${now})`)
}
for (const f of existing.filter((x) => isTest(x) && /\.(ts|tsx)$/.test(x))) {
  const now = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').length
  if (now > 800) warnings.push(`test file over 800 lines: ${f} (${now})`)
}
done()

function writePacket(verdict) {
  const dir = path.join(S, 'exec/packets'); fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${ID}.r${ROUND}.md`)
  const commitsTxt = C.map((c) => `- ${c.sha.slice(0, 10)} ${c.subject}\n${c.files.map((f) => `    - ${f}`).join('\n')}`).join('\n')
  const diff = git('diff', '-M', '--stat', BASE, head) + '\n' + git('diff', '-M', BASE, head)
  const body = [`# Review packet ${ID} round ${ROUND}`, `Worktree: ${WT}\nBase: ${BASE}\nHead: ${head}\nGate verdict: ${verdict}\nGate log (full test/verify output): ${LOG}`,
    '## Unit spec', '```json', JSON.stringify(unit, null, 2), '```',
    '## Gate', `Failures:\n${failures.map((f) => `- ${f}`).join('\n') || '- none'}\nWarnings:\n${warnings.map((f) => `- ${f}`).join('\n') || '- none'}\nEvidence:\n${evidence.map((f) => `- ${f}`).join('\n')}`,
    '## Commits', commitsTxt, '## Diff (base..head)', '```diff', diff, '```'].join('\n\n')
  fs.writeFileSync(p, body)
  return p
}
