// One-time-per-rebase ceiling reconciliation: raise grown / add new offenders to the tool's
// own measured size. Never touches limits, exemptions, renames, or removes entries.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { checkRepository } = await import(pathToFileURL(join(root, 'tools/scripts/size-budget.mjs')).href)
const { errors } = checkRepository(root, { strict: false })
const changes = []
for (const e of errors) {
  const m = /^([\w-]+): (Grown|New) offender (.+?) \((\w+)\): (\d+) lines(?:, baseline (\d+))?$/.exec(e)
  if (!m) { console.error('UNHANDLED', e); process.exit(2) }
  const [, pkg, kind, key, , lines, old] = m
  const file = join(root, 'tools/budgets', `${pkg}.json`)
  const b = JSON.parse(readFileSync(file, 'utf8'))
  if (kind === 'Grown' && b.offenders[key] !== Number(old)) { console.error('MISMATCH', e); process.exit(2) }
  b.offenders[key] = Number(lines)
  writeFileSync(file, JSON.stringify(b, null, 2) + '\n')
  changes.push(`${pkg}: ${key} ${old ?? 'new'} -> ${lines}`)
}
console.log(changes.join('\n'))
