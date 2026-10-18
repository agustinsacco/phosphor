// Merge every planner WBS into one program, normalize cross-scope decisions, and check integrity.
// Usage: node aggregate.cjs <plansDir> <outJson>
const fs = require('node:fs')
const path = require('node:path')
const [dir, out] = process.argv.slice(2)
const SCOPES = ['fixes', 'cross-cutting', 'libs-shared', 'libs-runtime', 'desktop-main', 'desktop-chat-a',
  'desktop-chat-b', 'desktop-core-a', 'desktop-core-b', 'desktop-features-a', 'desktop-features-b',
  'desktop-e2e', 'host-a', 'host-b', 'control-site']
const units = []
const missing = []
for (const s of SCOPES) {
  const f = path.join(dir, `${s}.json`)
  if (!fs.existsSync(f)) { missing.push(s); continue }
  for (const u of JSON.parse(fs.readFileSync(f, 'utf8'))) units.push({ ...u, scope: s })
}
const notes = []

// ---- Normalizations (decisions made during planning) ----
for (const u of units) {
  const s = JSON.stringify(u)
  if (/assertOwnerOnly/.test(s)) {
    Object.assign(u, JSON.parse(s.replace(/assertOwnerOnly\(\s*stat\s*,\s*expectedMode\s*,\s*uid\s*\)/g, 'isOwnerPrivate(stat, uid)').replace(/assertOwnerOnly/g, 'isOwnerPrivate')))
    notes.push(`${u.id}: assertOwnerOnly -> isOwnerPrivate`)
  }
}
const dfa44 = units.find((u) => u.id === 'DFA-44')
if (dfa44) {
  const before = dfa44.owns.length
  dfa44.owns = dfa44.owns.filter((p) => p !== 'CLAUDE.md' && p !== 'README.md')
  dfa44.docs = (dfa44.docs || []).filter((d) => !/^(CLAUDE|README)\.md/.test(d))
  if (!(dfa44.depends_on || []).includes('DKA-FACT6')) (dfa44.depends_on ||= []).push('DKA-FACT6')
  if (before !== dfa44.owns.length) notes.push('DFA-44: CLAUDE.md/README.md handed to DKA-FACT6')
  if (dfa44.owns.length === 0) { units.splice(units.indexOf(dfa44), 1); notes.push('DFA-44 removed (empty after handoff)') }
}
// ---- Supervisor amendments ----
const find = (id) => units.find((u) => u.id === id)
const ts = find('HB-TS-STRICT')
if (ts && !ts.owns.includes('apps/host/src/commands/guided-prerequisites.ts')) {
  ts.owns.push('apps/host/src/commands/guided-prerequisites.ts')
  notes.push('HB-TS-STRICT: owns guided-prerequisites.ts (host-b narrative amendment; HB-25 already orders it)')
}
const rth = find('libs:runtime-tests-home')
if (rth && !rth.findings.includes('r1-F7')) rth.findings.push('r1-F7')
const kbDeps = units.filter((u) => u.scope === 'desktop-core-b' && u.owns.some((o) => /apps\/desktop\/src\/(features\/sessions|components)\//.test(o))).map((u) => u.id)
if (!find('DKB-FF')) units.push({
  id: 'DKB-FF', pr: 'desktop-core', scope: 'desktop-core-b', title: 'Adopt fireAndForget for detached promises in sessions UI and shared components',
  kind: 'fix', findings: ['r3-F8'], risk: 'medium', coder: 'sol', review: 'standard', size: 'M',
  owns: ['apps/desktop/src/features/sessions/** (dispatch-time list: files with a detached promise and no rejection handler)', 'apps/desktop/src/components/** (same rule; excludes useAsyncAction/useIpcQuery/useLocalHealth/localHealthResource owned by DFA-01..03)', 'apps/desktop/test/renderer/features/sessions/fireAndForget.adoption.test.ts'],
  reads: ['apps/desktop/src/lib/fireAndForget.ts'], depends_on: ['DKA-FF', ...kbDeps], contracts: ['none'],
  design: 'After every core-b split lands, list call sites with `rg -n "^\\s*void " apps/desktop/src/features/sessions apps/desktop/src/components` and replace only promises whose rejection is unhandled with fireAndForget(promise, label). Keep launch order and synchronous flow; never add await; leave calls that already catch, and non-promise void expressions, untouched.',
  characterize_first: [{ test: 'apps/desktop/test/renderer/features/sessions/fireAndForget.adoption.test.ts', behaviors: ['A rejecting refreshDisk/readTree/openExternal call today surfaces as an unhandled rejection (recorded as the failing regression)', 'Success paths still fire in the same order'] }],
  new_tests: [], existing_tests: [], verify: ['npx vitest run apps/desktop/test/renderer/features/sessions apps/desktop/test/renderer/components', 'npm run typecheck', 'npm run lint'],
  extra_gates: ['owns list frozen in the PR description at dispatch'], acceptance: ['No detached promise without a rejection handler remains in the two directories', 'Rejections are logged with a label, never rethrown'], docs: [],
  notes: 'Supervisor-added: core-b planner timed out before writing its adoption unit for the DKA-FF contract.',
})
if (!find('CL-05')) units.push({
  id: 'CL-05', pr: 'cleanup', scope: 'cross-cutting', title: 'Collapse internal-only re-export chains (shared -> runtime -> desktop)',
  kind: 'dead-code', findings: ['r8-F14'], risk: 'low', coder: 'sol', review: 'standard', size: 'S',
  owns: ['libs/session-runtime/src/pi/machine-prompt.ts', 'libs/session-runtime/src/pi/directives.ts', 'importers of those two re-exports (dispatch-time list)'],
  reads: ['libs/session-runtime/src/pi/pi-paths.ts'], depends_on: ['CL-01'], contracts: ['none'],
  design: 'Point internal importers at libs/shared directly and delete re-exports with no production consumer. Keep the documented pi-paths re-export (CLAUDE.md sharp edge) and every package `exports` entry.',
  characterize_first: [], new_tests: [], existing_tests: [], verify: ['npm run typecheck', 'npm run lint', 'npm test'], extra_gates: [],
  acceptance: ['No behaviour change; boundary test passes', 'pi-paths.ts re-export kept'], docs: [], notes: 'Supervisor-added for traceability; libs-runtime and libs-shared both deferred it to cleanup.',
})
// Coder routing: opus codes security, high-risk fix/perf/extract/tooling, high-stakes contracts and sharp-edge files; sol codes the rest. Opus reviews every unit.
const HC = new Set(['session-files', 'host-grant', 'host-protocol', 'supabase-schema', 'release', 'pi-paths'])
const SHARP = /stores\/sessions\.ts|session-writer|mac-installer|worktree-paths|tool-name-guard|artifact-protocol|file-protocol|preload|ipc\/handle\.ts|vault|identity/
for (const u of units) {
  const opus = u.kind === 'security' || (u.risk === 'high' && ['fix', 'perf', 'dedupe-extract', 'tooling'].includes(u.kind)) ||
    (u.contracts || []).some((c) => HC.has(c)) || u.owns.some((o) => SHARP.test(o))
  u.plannerCoder = u.coder
  u.coder = opus ? 'opus' : 'sol'
  u.reviewer = u.review === 'none' ? 'none' : 'opus'
}
const DEFERRED = { 'r8-F15': 'RPC request timeout (opinion): deferred; compaction may legitimately run long, needs separate design' }
// Map registry-append manifests: exports maps are append-only, not exclusive.
const REGISTRY = new Set(['libs/shared/package.json', 'libs/session-runtime/package.json', 'libs/pi-extensions/package.json'])
// Section-owned doc hotspots: merged serially by the integrator.
const DOC_HOTSPOTS = new Set(['CLAUDE.md', 'README.md', 'docs/README.md', 'docs/known-issues.md', 'docs/host.md'])

// ---- Integrity checks ----
const byId = new Map(units.map((u) => [u.id, u]))
const dupIds = units.filter((u, i) => units.findIndex((v) => v.id === u.id) !== i).map((u) => u.id)
const PR_KEYS = new Set(['foundation', 'fixes', 'reloc', 'tooling', 'libs', 'desktop-main', 'desktop-chat', 'desktop-core',
  'desktop-features', 'desktop-e2e', 'host', 'control', 'site', 'cleanup', 'desktop-features-a'])
const LIB_KEYS = ['libs:status-keys', 'libs:title-policy', 'libs:print-mode', 'libs:git-worktrees', 'libs:routine-executor',
  'libs:tailscale-status', 'libs:sqlite-loader', 'libs:pi-api-types', 'libs:worktree-segment', 'libs:runtime-tests-home']
// Resolve a dependency to concrete unit ids.
function resolve(dep) {
  if (byId.has(dep)) return [dep]
  if (dep.startsWith('fixes:')) {
    const tag = dep.slice(6)
    const hits = units.filter((u) => u.pr === 'fixes' && (u.findings || []).concat(u.title, u.id).some((x) => new RegExp(`\\b${tag}\\b`).test(x)))
    return hits.length ? hits.map((u) => u.id) : null
  }
  if (PR_KEYS.has(dep)) {
    const pr = dep === 'desktop-features-a' ? null : dep
    const hits = pr ? units.filter((u) => u.pr === pr) : units.filter((u) => u.scope === 'desktop-features-a')
    return hits.length ? hits.map((u) => u.id) : null
  }
  return null
}
const dangling = []
const edges = new Map(units.map((u) => [u.id, new Set()]))
for (const u of units) {
  for (const d of u.depends_on || []) {
    const r = resolve(d)
    if (!r) { dangling.push(`${u.id} -> ${d}`); continue }
    for (const t of r) if (t !== u.id && !(PR_KEYS.has(d) && byId.get(t)?.pr === u.pr)) edges.get(u.id).add(t)
  }
}
// Cycle detection
const state = new Map(); const cycles = []
function dfs(id, stack) {
  state.set(id, 1); stack.push(id)
  for (const t of edges.get(id) || []) {
    if (state.get(t) === 1) cycles.push(stack.slice(stack.indexOf(t)).concat(t).join(' > '))
    else if (!state.get(t)) dfs(t, stack)
  }
  stack.pop(); state.set(id, 2)
}
for (const u of units) if (!state.get(u.id)) dfs(u.id, [])
// Reachability for ownership ordering
const reach = new Map()
function ancestors(id) {
  if (reach.has(id)) return reach.get(id)
  const set = new Set(); reach.set(id, set)
  for (const t of edges.get(id) || []) { set.add(t); for (const a of ancestors(t)) set.add(a) }
  return set
}
const owners = new Map()
for (const u of units) for (const p of u.owns || []) {
  const key = p.replace(/\s*\(.*\)$/, '').trim()
  if (REGISTRY.has(key) || DOC_HOTSPOTS.has(key) || key.includes('*')) continue
  ;(owners.get(key) || owners.set(key, []).get(key)).push(u.id)
}
const conflicts = []
const docSerial = []
for (const [file, ids] of owners) {
  if (ids.length < 2) continue
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j]
    if (ancestors(a).has(b) || ancestors(b).has(a)) continue
    // Living docs are section-owned and merged serially by the integrator.
    if (/^docs\/.*\.md$/.test(file)) docSerial.push({ file, a, b })
    else conflicts.push({ file, a, b })
  }
}
// Topological waves
const waveOf = new Map()
function wave(id) {
  if (waveOf.has(id)) return waveOf.get(id)
  waveOf.set(id, 0)
  let w = 0
  for (const t of edges.get(id) || []) w = Math.max(w, wave(t) + 1)
  waveOf.set(id, w); return w
}
for (const u of units) u.wave = wave(u.id)

const tally = (k) => units.reduce((a, u) => ((a[u[k]] = (a[u[k]] || 0) + 1), a), {})
const libProvided = LIB_KEYS.filter((k) => byId.has(k))
const summary = {
  units: units.length, missingScopes: missing, byPr: tally('pr'), byKind: tally('kind'), byRisk: tally('risk'),
  byCoder: tally('coder'), bySize: tally('size'), maxWave: Math.max(...units.map((u) => u.wave)),
  libKeysProvided: libProvided, libKeysMissing: LIB_KEYS.filter((k) => !byId.has(k)),
  deferred: DEFERRED, dupIds, dangling, cycles: cycles.slice(0, 20), conflicts: conflicts.length, conflictSample: conflicts.slice(0, 40), docSerial, notes,
}
fs.writeFileSync(out, JSON.stringify({ summary, units }, null, 1))
console.log(JSON.stringify(summary, null, 1))
