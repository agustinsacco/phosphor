import { expect, it } from 'vitest'
import { emptyBrainTidyCoverage, type BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import { createTidyMaintenance } from './maintenance'

function harness(pending: string[][]) {
  const batches: number[] = []
  const events: string[] = []
  const maintenance = createTidyMaintenance({
    store: {
      takeTidyMaintenance: () => pending.shift() ?? [],
      sweep: (touched: BrainTidyTouched | 'all') => {
        if (touched === 'all') throw new Error('Maintenance never runs a whole-Brain pass.')
        batches.push(touched.memoryIds.length)
        events.push('sweep')
        return {
          coverage: emptyBrainTidyCoverage(),
          suggestions: 0,
          unlinked: 0,
          folded: 0,
          operationIds: [],
        }
      },
    },
    search: {
      refresh: async () => {
        events.push('refresh')
      },
    },
    notify: () => events.push('notify'),
  })
  return { maintenance, batches, events }
}
const ids = (count: number) => Array.from({ length: count }, (_, i) => `memory-${i}`)
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await turn()
}

it('sweeps nothing inside the caller, then batches of 128 with a refresh and notice after each', async () => {
  const { maintenance, batches, events } = harness([ids(300)])
  maintenance.schedule()
  expect(batches).toEqual([])
  await turn()
  expect(batches).toEqual([128])
  await settle()
  expect(batches).toEqual([128, 128, 44])
  expect(events).toEqual([
    'sweep',
    'refresh',
    'notify',
    'sweep',
    'refresh',
    'notify',
    'sweep',
    'refresh',
    'notify',
  ])
})

it('picks up ids deferred while it is draining', async () => {
  const { maintenance, batches } = harness([ids(130), ids(5)])
  maintenance.schedule()
  maintenance.schedule()
  await settle()
  expect(batches).toEqual([128, 2, 5])
})

it('stops between batches when Brain is disposed or reset', async () => {
  const stopped = harness([ids(1000)])
  stopped.maintenance.schedule()
  await turn()
  await stopped.maintenance.stop()
  stopped.maintenance.schedule()
  await settle()
  expect(stopped.batches).toEqual([128])
  const reset = harness([ids(1000), ids(3)])
  reset.maintenance.schedule()
  await turn()
  reset.maintenance.reset()
  await settle()
  expect(reset.batches).toEqual([128])
  reset.maintenance.schedule()
  await settle()
  expect(reset.batches).toEqual([128, 3])
})

it('stops quietly on a failed sweep and leaves the rest to Defrag', async () => {
  const logged: string[] = []
  const maintenance = createTidyMaintenance({
    store: {
      takeTidyMaintenance: () => ids(300),
      sweep: () => {
        throw new Error('Invented sweep failure')
      },
    },
    search: { refresh: async () => {} },
    notify: () => {},
    log: (message) => logged.push(message),
  })
  maintenance.schedule()
  await settle()
  expect(logged).toEqual(['Brain Tidy maintenance stopped'])
})
