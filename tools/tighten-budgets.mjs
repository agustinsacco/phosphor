// Ratchet down: for files changed since <base>, lower baseline ceilings to the measured size and
// drop entries that are no longer offenders. Never raises; skips rename sources; edits values in place.
//   node tighten-budgets.mjs <repo> <base-sha>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const [root, base] = process.argv.slice(2)
const { checkRepository, PACKAGES } = await import(pathToFileURL(join(root, 'tools/scripts/size-budget.mjs')).href)
const changed = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const { errors, packages } = checkRepository(root, {})
if (errors.length) { console.error('budget errors first:', errors); process.exit(2) }
const rel = (name, file) => (PACKAGES[name] && file.startsWith(PACKAGES[name] + '/') ? file.slice(PACKAGES[name].length + 1) : name === 'tooling' ? file : null)
const log = []
for (const name of Object.keys(PACKAGES)) {
  const files = new Set(changed.map((f) => rel(name, f)).filter(Boolean))
  if (!files.size) continue
  const p = join(root, 'tools/budgets', `${name}.json`)
  const b = JSON.parse(readFileSync(p, 'utf8'))
  const renamed = new Set(Object.keys(b.renames || {}))
  for (const [key, ceiling] of Object.entries(b.offenders)) {
    const file = key.split('::')[0]
    if (!files.has(file) || renamed.has(file)) continue
    const now = packages[name][key]
    if (now === undefined) { delete b.offenders[key]; log.push(`${name}: ${key} ${ceiling} -> removed`) }
    else if (now < ceiling) { b.offenders[key] = now; log.push(`${name}: ${key} ${ceiling} -> ${now}`) }
  }
  writeFileSync(p, JSON.stringify(b, null, 2) + '\n')
}
console.log(log.join('\n') || 'nothing to tighten')
