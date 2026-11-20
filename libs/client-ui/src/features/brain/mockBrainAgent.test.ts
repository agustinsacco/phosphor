import { expect, it } from 'vitest'
import type { BrainStatus, BrainUndoRunResult } from '@shared/brain'
import { DEFAULT_BRAIN_PREFS } from '@shared/brain'
import type { BrainTidyChanges } from '@shared/brain-tidy'
import { createMockBrain } from './mockBrain'

it('runs Defrag through queued and running to reasoned changes, and undoes a run without its erasure', async () => {
  let now = 1793966400000
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now += 6000
  const status = await call('brain:status', []) as BrainStatus
  expect(status.agent.waiting.reads).toBe(1)
  expect(Object.values(status.agent.waiting).reduce((a,b) => a+b,0)).toBeGreaterThan(1)
  expect((await call('brain:defrag', []) as BrainStatus).agent.run?.state).toBe('queued')
  now += 2000
  expect((await call('brain:status', []) as BrainStatus).agent.run?.state).toBe('running')
  now += 20000
  const done = await call('brain:status', []) as BrainStatus
  expect(done.agent.run?.state).toBe('done')
  const changes = await call('brain:tidyChanges', [50]) as BrainTidyChanges
  expect(changes.items.map((op) => op.kind)).toEqual(expect.arrayContaining(['approve', 'keep', 'merge', 'erase']))
  expect(changes.items.every((op) => op.who === 'agent' && !!op.reason)).toBe(true)
  expect(changes.items.find((op) => op.kind === 'erase')).toMatchObject({ undoable: false })
  const undo = await call('brain:undoRun', [done.agent.run!.id]) as BrainUndoRunResult
  expect(undo.undone).toBeGreaterThan(0)
  expect(undo.kept).toBeGreaterThan(0)
})
it('stops queued work, refuses duplicate Defrag and enforces argument bounds', async () => {
  const call = createMockBrain()
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  await call('brain:defrag', [])
  await expect(call('brain:defrag', [])).rejects.toThrow(/already/)
  expect((await call('brain:defragStop', []) as BrainStatus).agent.run?.state).toBe('stopped')
  for (const args of [[], [''], ['x'.repeat(201)], [42], ['run','extra']])
    await expect(call('brain:undoRun', args)).rejects.toThrow(/Invalid/)
  await expect(call('brain:defrag', ['extra'])).rejects.toThrow(/Invalid/)
  await expect(call('brain:defragStop', ['extra'])).rejects.toThrow(/Invalid/)
})
