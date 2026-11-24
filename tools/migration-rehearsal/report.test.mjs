import { expect, it } from 'vitest'
import { journalReport } from './report.mjs'

it('prints only fixed labels and counts; does not invent earlier passes', () => {
  const report = journalReport(
    {
      state: 'aborted',
      steps: [],
      failure: { step: 'verify', code: 'gate-g4', message: 'sensitive' },
    },
    { expected: { folders: 7, lanes: 'sensitive', sensitive: 1 } },
    Date.now(),
  )
  expect(report).toMatchObject({
    complete: false,
    failureStep: 'verify',
    gateResults: { G4: 'fail', G1: 'unverified' },
    expected: { folders: 7 },
  })
  expect(JSON.stringify(report)).not.toContain('sensitive')
})
it('requires the post-commit steps and done, not just a committed journal', () => {
  const j = { state: 'committed', steps: [{ step: 'verify', status: 'done' }] }
  expect(journalReport(j, null, Date.now()).complete).toBe(false)
  for (const step of ['device', 'quarantine', 'done']) j.steps.push({ step, status: 'done' })
  expect(journalReport(j, null, Date.now()).complete).toBe(true)
})
