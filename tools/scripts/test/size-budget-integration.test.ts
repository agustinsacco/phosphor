import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { evaluateBudget, PACKAGES } from '../size-budget.mjs'
import { measureSource } from '../size-spans.mjs'

const root = resolve(import.meta.dirname, '../../..')

it.each(['web', 'client-ui', 'host-client'] as const)(
  'keeps every reconciled %s ceiling a one-way ratchet',
  (name) => {
    const budget = JSON.parse(readFileSync(resolve(root, `tools/budgets/${name}.json`), 'utf8'))
    expect(Object.keys(budget.offenders).length).toBeGreaterThan(0)
    // One measurement per file: re-measuring for every offender key took >5 s on CI.
    const measured = new Map<string, ReturnType<typeof measureSource>>()
    for (const [key, ceiling] of Object.entries(budget.offenders) as [string, number][]) {
      const file = key.split('::')[0]!
      if (!measured.has(file))
        measured.set(
          file,
          measureSource(file, readFileSync(resolve(root, PACKAGES[name], file), 'utf8')),
        )
      const span = measured.get(file)!.find((entry) => entry.key === key)
      // Removed functions may retain their old ceilings, but never gain new credit.
      if (!span) continue
      const isolated = { ...budget, offenders: { [key]: ceiling }, exemptions: [], renames: {} }
      expect(evaluateBudget([{ ...span, lines: ceiling }], isolated).errors, key).toEqual([])
      expect(evaluateBudget([{ ...span, lines: ceiling + 1 }], isolated).errors, key).toEqual([
        expect.stringContaining('Grown offender'),
      ])
    }
  },
)
