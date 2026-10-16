import { expect, it } from 'vitest'
import { parseMachineClaude, parseMachineParams } from '@phosphor/shared/host-protocol-machine'

it('accepts exactly the three machine.claude enum fields and empty params', () => {
  for (const provider of ['ok', 'missing', 'outdated'])
    for (const cli of ['ok', 'missing'])
      for (const auth of ['ok', 'signed-out', 'unknown']) {
        const value = { provider, cli, auth }
        expect(parseMachineClaude(value)).toEqual(value)
      }
  expect(parseMachineParams('machine.claude', {})).toEqual({})
  expect(parseMachineParams('machine.claude', { laneId: 'not-permitted' })).toBe(null)
})

it.each([
  null,
  [],
  {},
  { provider: 'ok', cli: 'ok' },
  { provider: 'old', cli: 'ok', auth: 'ok' },
  { provider: 'ok', cli: true, auth: 'ok' },
  { provider: 'ok', cli: 'ok', auth: 'logged-in' },
  { provider: 'ok', cli: 'ok', auth: 'ok', extra: 'private' },
])('rejects malformed Claude diagnostics %j', (value) =>
  expect(parseMachineClaude(value)).toBe(null),
)
