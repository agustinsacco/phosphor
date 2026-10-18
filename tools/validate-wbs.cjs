// Validate a planner's WBS JSON. Usage: node validate-wbs.cjs <file.json> <ID-prefix,...>
const fs = require('node:fs')
const [file, prefixes] = process.argv.slice(2)
const PRS = ['foundation','fixes','reloc','tooling','libs','desktop-main','desktop-chat','desktop-core','desktop-features','desktop-e2e','host','control','site','cleanup']
const KINDS = ['decompose','fix','security','perf','dedupe-adopt','dedupe-extract','tests','tooling','lint','docs','dead-code']
const errors = []
let units
try { units = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { console.log(JSON.stringify({ ok: false, errors: ['unreadable or invalid JSON: ' + e.message] })); process.exit(1) }
if (!Array.isArray(units) || units.length === 0) errors.push('top level must be a non-empty array')
const ids = new Set()
const allowed = (prefixes || '').split(',').filter(Boolean)
for (const [i, u] of (units || []).entries()) {
  const at = `unit[${i}] ${u && u.id}`
  if (!u || typeof u !== 'object') { errors.push(`${at}: not an object`); continue }
  for (const k of ['id','pr','title','kind','risk','coder','review','design','size']) if (typeof u[k] !== 'string' || !u[k]) errors.push(`${at}: missing ${k}`)
  for (const k of ['owns','verify','acceptance']) if (!Array.isArray(u[k]) || u[k].length === 0) errors.push(`${at}: ${k} must be a non-empty array`)
  for (const k of ['findings','reads','depends_on','contracts','characterize_first','new_tests','existing_tests','extra_gates','docs']) if (u[k] !== undefined && !Array.isArray(u[k])) errors.push(`${at}: ${k} must be an array`)
  if (u.id && ids.has(u.id)) errors.push(`${at}: duplicate id`); ids.add(u.id)
  if (u.id && allowed.length && !allowed.some((p) => u.id.startsWith(p))) errors.push(`${at}: id prefix not in ${allowed}`)
  if (u.pr && !PRS.includes(u.pr)) errors.push(`${at}: unknown pr ${u.pr}`)
  if (u.kind && !KINDS.includes(u.kind)) errors.push(`${at}: unknown kind ${u.kind}`)
  if (!['low','medium','high'].includes(u.risk)) errors.push(`${at}: bad risk`)
  if (!['sol','opus'].includes(u.coder)) errors.push(`${at}: bad coder`)
  if (u.kind === 'decompose') {
    const pinned = (u.characterize_first || []).length + (u.existing_tests || []).length
    if (!pinned) errors.push(`${at}: decompose unit without characterization or existing tests`)
    if (!(u.new_tests || []).length) errors.push(`${at}: decompose unit without new_tests for extracted pieces`)
  }
  if (['fix','security','perf'].includes(u.kind) && !(u.new_tests || []).length && !(u.characterize_first || []).length) errors.push(`${at}: ${u.kind} unit without a regression test`)
}
const byKind = {}; const byPr = {}
for (const u of units || []) { byKind[u.kind] = (byKind[u.kind] || 0) + 1; byPr[u.pr] = (byPr[u.pr] || 0) + 1 }
console.log(JSON.stringify({ ok: errors.length === 0, units: (units || []).length, byKind, byPr, errors: errors.slice(0, 40) }))
process.exit(errors.length ? 1 : 0)
