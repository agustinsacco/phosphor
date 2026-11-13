import { expect, it } from 'vitest'
import { prCheck, prDetail, prSummary } from '../__fixtures__/pullRequests'
import { checkDuration, checkNote, groupChecks, inspectorChecks } from './checkGroups'

const names = (list: { name: string }[]) => list.map((c) => c.name)

it('lists failing, then running, then required passing; folds the rest and skipped', () => {
  const groups = groupChecks([
    prCheck('docs', 'success'),
    prCheck('build', 'success', true),
    prCheck('bot', 'failure'),
    prCheck('coverage', 'skipped'),
    prCheck('unit', 'pending', true),
    prCheck('lint', 'failure', true),
    prCheck('e2e', 'pending'),
    prCheck('rocky', 'neutral'),
  ])
  expect(names(groups.lead)).toEqual(['lint', 'bot', 'unit', 'e2e', 'build'])
  expect(names(groups.rest)).toEqual(['docs', 'rocky'])
  expect(names(groups.skipped)).toEqual(['coverage'])
  expect(groups.counts).toEqual({
    passed: 2,
    failed: 2,
    pending: 2,
    neutral: 1,
    skipped: 1,
    total: 8,
  })
  expect(groups.known).toBe(true)
})

it('keeps GitHub order inside a group', () => {
  const groups = groupChecks([prCheck('b', 'success', true), prCheck('a', 'success', true)])
  expect(names(groups.lead)).toEqual(['b', 'a'])
})

it('never reads unknown checks as an empty green list', () => {
  const groups = groupChecks(null)
  expect(groups.known).toBe(false)
  expect(groups.counts.total).toBe(0)
})

it('prefers the detail read and carries truncation from either read', () => {
  const summary = prSummary({ checksTruncated: true })
  expect(inspectorChecks(summary, undefined)).toMatchObject({ truncated: true })
  expect(inspectorChecks(summary, undefined).checks).toBe(summary.checkRuns)
  const detail = prDetail()
  expect(inspectorChecks(summary, detail).checks).toBe(detail.checks)
  expect(inspectorChecks(summary, { ...detail, checks: null }).checks).toBe(summary.checkRuns)
  expect(inspectorChecks(undefined, undefined)).toEqual({ checks: null, truncated: false })
})

it('times a finished or running check', () => {
  const now = Date.parse('2026-11-13T04:10:00Z')
  const check = { ...prCheck('x', 'success'), startedAt: '2026-11-13T04:00:00Z' }
  expect(checkDuration({ ...check, completedAt: '2026-11-13T04:01:27Z' }, now)).toBe('1m 27s')
  expect(checkDuration({ ...check, completedAt: '2026-11-13T04:00:09Z' }, now)).toBe('9s')
  expect(checkDuration(check, now)).toBe('10m 0s')
  expect(checkDuration(prCheck('x', 'success'), now)).toBeUndefined()
})

it('explains a check by its first annotation, else its title', () => {
  const failing = prDetail().checks![0]!
  expect(checkNote(failing)).toBe('Write commands need an explicit opt-in (cli/src/run.ts:248)')
  expect(checkNote(prCheck('rocky', 'failure', false, '1 unresolved finding'))).toBe(
    '1 unresolved finding',
  )
})
