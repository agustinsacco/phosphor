import { expect, it } from 'vitest'
import {
  parseMachineClaude,
  parseMachineClaudeUsage,
  parseMachineParams,
} from '@phosphor/shared/host-protocol-machine'

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

const usage = {
  ok: true,
  snapshot: {
    fetchedAt: 1_760_000_000_000,
    stale: false,
    windows: [
      { label: 'Current session', kind: 'five_hour', percentUsed: 12, resetsAt: 1_760_001_000_000 },
      { label: 'Current week (all models)', kind: 'weekly', percentUsed: 40, resetsAt: null },
    ],
  },
}

it('accepts plan usage windows and only a boolean force param', () => {
  expect(parseMachineClaudeUsage(usage)).toEqual({
    ok: true,
    snapshot: { ...usage.snapshot, contributing: null },
  })
  expect(parseMachineClaudeUsage({ ok: false, error: 'no-usage' })).toEqual({
    ok: false,
    error: 'no-usage',
  })
  expect(parseMachineParams('machine.claudeUsage', {})).toEqual({})
  expect(parseMachineParams('machine.claudeUsage', { force: true })).toEqual({ force: true })
  expect(parseMachineParams('machine.claudeUsage', { force: 'yes' })).toBe(null)
  const laneId = '00000000-0000-4000-8000-000000000098'
  expect(parseMachineParams('machine.claudeUsage', { laneId, force: true })).toEqual({
    laneId,
    force: true,
  })
  expect(parseMachineParams('machine.claudeUsage', { laneId: '../lane' })).toBe(null)
  expect(parseMachineParams('machine.claude', { force: true })).toBe(null)
})

const window = usage.snapshot.windows[0]
it.each([
  null,
  { ok: false, error: 'secret text' },
  { ok: true },
  { ok: true, snapshot: { ...usage.snapshot, stale: 'no' } },
  { ok: true, snapshot: { ...usage.snapshot, windows: Array(17).fill(window) } },
  { ok: true, snapshot: { ...usage.snapshot, windows: [{ ...window, kind: 'monthly' }] } },
  { ok: true, snapshot: { ...usage.snapshot, windows: [{ ...window, percentUsed: 201 }] } },
  { ok: true, snapshot: { ...usage.snapshot, windows: [{ ...window, resetsAt: 'soon' }] } },
  { ok: true, snapshot: { ...usage.snapshot, windows: [{ ...window, label: '' }] } },
])('rejects malformed plan usage %j', (value) => expect(parseMachineClaudeUsage(value)).toBe(null))
