import { expect, it, vi } from 'vitest'
import type { BrainAgentHost, BrainAgentTurn } from '../types'
import { savedRead, realService, curatorClient } from '../tidy/__fixtures__/real-service'
const finished: BrainAgentTurn = {
  outcome: 'finished',
  error: null,
  sessionPath: null,
  rulesChanged: false,
}

/**
 * The Brain lane as Defrag finds it while the owner has a turn running there: Defrag's turn
 * waits for `ownerDone`, then sends its message and runs `own` as Brain Agent.
 */
function ownerBusyLane(own: (signal: AbortSignal) => Promise<void> = async () => {}) {
  let ownerDone!: () => void
  const owner = new Promise<void>((resolve) => (ownerDone = resolve))
  const turn = vi.fn<BrainAgentHost['turn']>(
    (_message, signal, hooks) =>
      new Promise<BrainAgentTurn>((resolve, reject) => {
        signal.addEventListener('abort', () => resolve({ ...finished, outcome: 'stopped' }))
        owner
          .then(async () => {
            if (signal.aborted) return
            hooks.sending()
            await own(signal)
            resolve(finished)
          })
          .catch(reject)
      }),
  )
  return { host: { folder: '/made-up/brain/Brain', tell: vi.fn(), turn }, turn, ownerDone }
}

it('a change the owner asks for while Defrag waits for their turn belongs to no run', async () => {
  const describe = async (entityId: string, description: string, reason: string) => {
    const result = await curator.call('edit', {
      edit: { kind: 'describe', entityId, description },
      reason,
    })
    expect(result.status).toBe('done')
    return result.operationId!
  }
  const ids: { rina?: string; okafor?: string } = {}
  const lane = ownerBusyLane(async () => {
    await describe(ids.okafor!, 'Owns the Ledger invoices.', 'The lane says Rina owns invoices.')
  })
  const s = await realService({
    curator: { extension: '/made-up/brain-curator.mjs', skill: '/made-up/brain-agent' },
    agent: lane.host,
  })
  const curator = await curatorClient(s.service)
  await savedRead(s.store, s.service, s.options)
  const [first, , third] = s.store.laneMemories('harbor-read').ids
  ids.rina = s.store.memory(first!).entities[0]!.id
  ids.okafor = s.store.memory(third!).entities[0]!.id
  await s.service.api.defrag()
  await vi.waitFor(() => expect(lane.turn).toHaveBeenCalled())

  const owners = await describe(ids.rina, 'Leads Ledger at Harbor.', 'The owner asked for it.')
  const change = () => s.store.tidyChanges(10).items.find((item) => item.id === owners)
  expect(change()).toMatchObject({ who: 'agent', runId: null })

  lane.ownerDone()
  await vi.waitFor(async () => expect((await s.service.api.status()).agent.run?.state).toBe('done'))
  const run = (await s.service.api.status()).agent.run!
  expect(run).toMatchObject({ decided: 1, undoable: 1 })
  await expect(s.service.api.undoRun(run.id)).resolves.toMatchObject({ undone: 1, kept: 0 })
  expect(change()).toMatchObject({ runId: null, undoneAt: null })
  expect(s.store.entity(ids.rina).entity.description).toBe('Leads Ledger at Harbor.')
})
