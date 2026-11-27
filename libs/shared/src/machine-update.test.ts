import { expect, it } from 'vitest'
import { parseMachineUpdateReport } from './machine-update'

const last = { from: '1.2.0', to: '1.3.0', outcome: 'rolled-back', at: '2026-11-26T11:00:00.000Z' }

it('reads every field of a full report', () => {
  const report = {
    supported: true,
    available: '1.3.0',
    checkedAt: '2026-11-26T12:00:00.000Z',
    pauseControl: true,
    last,
  }
  expect(parseMachineUpdateReport(report)).toEqual(report)
})

it('reads a source install and today’s pause-only object', () => {
  expect(parseMachineUpdateReport({ supported: false })).toEqual({ supported: false })
  // A Host before the self-check sends only the discovery bit: no report.
  expect(parseMachineUpdateReport({ pauseControl: true })).toBeUndefined()
  expect(parseMachineUpdateReport(undefined)).toBeUndefined()
  expect(parseMachineUpdateReport('yes')).toBeUndefined()
})

it('drops malformed optional fields instead of the report', () => {
  expect(
    parseMachineUpdateReport({
      supported: true,
      available: 'latest',
      checkedAt: 'yesterday',
      pauseControl: 'yes',
      last: { ...last, outcome: 'maybe' },
    }),
  ).toEqual({ supported: true })
  expect(parseMachineUpdateReport({ supported: true, last: { ...last, to: '1.3' } })).toEqual({
    supported: true,
  })
})
