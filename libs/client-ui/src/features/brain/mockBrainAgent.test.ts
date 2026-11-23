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
  const status = (await call('brain:status', [])) as BrainStatus
  expect(status.agent.waiting.reads).toBe(1)
  expect(Object.values(status.agent.waiting).reduce((a, b) => a + b, 0)).toBeGreaterThan(1)
  expect(((await call('brain:defrag', [])) as BrainStatus).agent.run?.state).toBe('queued')
  now += 2000
  expect(((await call('brain:status', [])) as BrainStatus).agent.run?.state).toBe('running')
  now += 20000
  const done = (await call('brain:status', [])) as BrainStatus
  expect(done.agent.run?.state).toBe('done')
  const changes = (await call('brain:tidyChanges', [50])) as BrainTidyChanges
  expect(changes.items.map((op) => op.kind)).toEqual(
    expect.arrayContaining(['approve', 'keep', 'merge', 'erase']),
  )
  expect(changes.items.every((op) => op.who === 'agent' && !!op.reason)).toBe(true)
  expect(changes.items.find((op) => op.kind === 'erase')).toMatchObject({ undoable: false })
  const undo = (await call('brain:undoRun', [done.agent.run!.id])) as BrainUndoRunResult
  expect(undo.undone).toBeGreaterThan(0)
  expect(undo.kept).toBeGreaterThan(0)
})
it('stops queued work, refuses duplicate Defrag and enforces argument bounds', async () => {
  const call = createMockBrain()
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  await call('brain:defrag', [])
  await expect(call('brain:defrag', [])).rejects.toThrow(/already/)
  expect(((await call('brain:defragStop', [])) as BrainStatus).agent.run?.state).toBe('stopped')
  for (const args of [[], [''], ['x'.repeat(201)], [42], ['run', 'extra']])
    await expect(call('brain:undoRun', args)).rejects.toThrow(/Invalid/)
  await expect(call('brain:defrag', ['extra'])).rejects.toThrow(/Invalid/)
  await expect(call('brain:defragStop', ['extra'])).rejects.toThrow(/Invalid/)
})

it('does not undo a run across a later Knowledge edit', async () => {
  let now = 1793966400000
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now += 6000
  await call('brain:defrag', [])
  now += 2000
  await call('brain:status', [])
  now += 20000
  const done = (await call('brain:status', [])) as BrainStatus
  await call('brain:describe', ['ledger', 'The corrected Ledger description.', done.revision])
  const result = (await call('brain:undoRun', [done.agent.run!.id])) as BrainUndoRunResult
  expect(result.kept).toBeGreaterThan(1)
  const ledger = (await call('brain:entity', ['ledger'])) as { entity: { description: string } }
  expect(ledger.entity.description).toBe('The corrected Ledger description.')
})
it('undoes approval back to waiting without duplicating its finished read', async () => {
  let now = 1793966400000
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now += 6000
  await call('brain:defrag', [])
  now += 2000
  await call('brain:status', [])
  now += 20000
  const done = (await call('brain:status', [])) as BrainStatus
  await call('brain:undoRun', [done.agent.run!.id])
  const status = (await call('brain:status', [])) as BrainStatus
  const history = (await call('brain:history', [200])) as { items: { job: { id: string } }[] }
  expect(status.jobs.some((job) => job.id === 'harbor-demo-review' && job.state === 'review')).toBe(
    true,
  )
  expect(history.items.some(({ job }) => job.id === 'harbor-demo-review')).toBe(false)
})

it('waits for earlier reads but keeps later reads behind Defrag', async () => {
  let now = 1793966400000
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now += 6000
  await call('brain:queue', [{ sessionPath: '/demo/Harbor/before.jsonl', title: 'Harbor before' }])
  await call('brain:defrag', [])
  await call('brain:queue', [{ sessionPath: '/demo/Harbor/after.jsonl', title: 'Harbor after' }])
  now += 4000
  await call('brain:status', [])
  const status = (await call('brain:status', [])) as BrainStatus
  expect(status.agent.run?.state).toBe('running')
  expect(status.jobs.find((job) => job.title === 'Harbor after')?.state).toBe('queued')
  await call('brain:defragStop', [])
  const stopped = (await call('brain:status', [])) as BrainStatus
  expect(stopped.jobs.find((job) => job.title === 'Harbor after')?.state).toBe('running')
})

it('keeps mock journal summaries engine-shaped without quoting memory text', async () => {
  let now = 1793966400000
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now += 6000
  await call('brain:defrag', [])
  now += 2000
  await call('brain:status', [])
  now += 20000
  await call('brain:status', [])
  const changes = (await call('brain:tidyChanges', [50])) as BrainTidyChanges
  const kept = changes.items.filter((op) => op.kind === 'keep')
  expect(kept.length).toBeGreaterThan(0)
  expect(kept.map((op) => op.summary)).toEqual(kept.map(() => 'Kept both as they are'))
})
