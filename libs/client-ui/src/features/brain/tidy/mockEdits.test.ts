import { expect, it } from 'vitest'
import type { BrainEntityView, BrainStatus } from '@shared/brain'
import type { BrainTidyChanges, BrainTidyMutation } from '@shared/brain-tidy'
import { createMockBrain } from '../mockBrain'
import { MockExplorer } from '../mockExplorer'
import { MockTidy } from './mockTidy'
import { mockBrainStatus } from '../mockBrainData'
import { seedMockTidy } from './mockTidyData'

const everyState = { states: ['active', 'disputed', 'superseded'] }
const revision = async (call: ReturnType<typeof createMockBrain>) =>
  ((await call('brain:status', [])) as BrainStatus).revision

it('describes, removes a name and splits a record in the harness, each with Undo', async () => {
  const call = createMockBrain(() => 10000)
  const described = (await call('brain:describe', [
    'harbor',
    '  Harbor customer account  ',
    await revision(call),
  ])) as BrainTidyMutation
  expect(((await call('brain:entity', ['harbor'])) as BrainEntityView).entity.description).toBe(
    'Harbor customer account',
  )
  await call('brain:removeName', ['harbor', 'Harbor customer', described.revision])
  expect(((await call('brain:entity', ['harbor'])) as BrainEntityView).entity.aliases).toEqual([])
  await expect(
    call('brain:removeName', ['harbor', 'Harbor customer', await revision(call)]),
  ).rejects.toThrow('no other name')

  const ids: string[] = []
  for (let cursor: string | null = null; ;) {
    const page = (await call('brain:entityMemories', ['harbor', everyState, cursor])) as {
      memories: { id: string }[]
      next: string | null
    }
    ids.push(...page.memories.map((m) => m.id))
    if (!(cursor = page.next)) break
  }
  expect(ids.length).toBeGreaterThan(1)
  const target = { label: 'Harbor vendor', kind: 'organization' }
  await expect(call('brain:split', ['harbor', ids, target, await revision(call)])).rejects.toThrow(
    'rename',
  )
  const split = (await call('brain:split', [
    'harbor',
    [ids[0]!],
    target,
    await revision(call),
  ])) as BrainTidyMutation
  const changes = (await call('brain:tidyChanges', [20])) as BrainTidyChanges
  expect(changes.items.map((op) => op.kind)).toEqual(['split', 'unname', 'describe'])
  await call('brain:tidyUndo', [split.operationId, split.revision])
  const view = (await call('brain:entity', ['harbor'])) as BrainEntityView
  expect(view.entity.memories).toBe(ids.length)
})

it.each([
  ['brain:describe', ['harbor', '   ', 0]],
  ['brain:describe', ['harbor', 'x'.repeat(161), 0]],
  ['brain:describe', ['', 'Harbor', 0]],
  ['brain:describe', ['harbor', 'Harbor', -1]],
  ['brain:removeName', ['harbor', '', 0]],
  ['brain:removeName', ['harbor', 'x'.repeat(201), 0]],
  ['brain:removeName', ['harbor', 'Harbor customer', 0.5]],
  ['brain:split', ['harbor', [], { label: 'Harbor vendor', kind: 'organization' }, 0]],
  ['brain:split', ['harbor', ['a', 'a'], { label: 'Harbor vendor', kind: 'organization' }, 0]],
  ['brain:split', ['harbor', ['a'], { label: ' ', kind: 'organization' }, 0]],
  ['brain:split', ['harbor', ['a'], { label: 'x'.repeat(81), kind: 'organization' }, 0]],
  ['brain:split', ['harbor', ['a'], { label: 'Harbor vendor', kind: 'vendor' }, 0]],
  ['brain:split', ['harbor', ['a'], { label: 'Harbor vendor', kind: 'person', x: 1 }, 0]],
])('refuses Desktop-invalid arguments to %s: %j', async (channel, args) => {
  const call = createMockBrain(() => 10000)
  await expect(call(channel, args)).rejects.toThrow('Invalid')
})

it('refuses to split off every current memory while a superseded one remains, as Desktop does', async () => {
  const explorer = new MockExplorer()
  seedMockTidy(explorer, 12, 10000)
  explorer.memory('tidy-2-0').memory.state = 'superseded'
  const state = mockBrainStatus()
  const tidy = new MockTidy(explorer, state, () => 10000, {})
  const named = async (states: string[]): Promise<string[]> => {
    const ids: string[] = []
    for (let cursor: string | null = null; ;) {
      const page = explorer.memories(
        'harbor',
        { states: states as ('active' | 'disputed' | 'superseded')[] },
        cursor,
      ) as {
        memories: { id: string }[]
        next: string | null
      }
      ids.push(...page.memories.map((m) => m.id))
      if (!(cursor = page.next)) return ids
    }
  }
  expect(await named(['superseded'])).toContain('tidy-2-0')
  const current = await named(['active', 'disputed'])
  const target = { label: 'Harbor vendor', kind: 'organization' }
  expect(() => tidy.edit('brain:split', ['harbor', current, target, state.revision])).toThrow(
    'rename',
  )
})
