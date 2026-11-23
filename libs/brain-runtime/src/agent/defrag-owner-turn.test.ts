import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainJob } from '@phosphor/shared/brain'
import { ExtractionQueue } from '../queue'
import { LaneFiles } from '../lane-files'
import { currentReadCheck } from '../lane-read-rules'
import type { BrainAgentHost, BrainAgentTurn, BrainService } from '../types'
import { seedReview } from '../__fixtures__/curator'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import { recallOptions } from '../__fixtures__/options'
import { approveRead, realService } from '../tidy/__fixtures__/real-service'
import { createCurator } from './curator'
import { createDefrag } from './defrag'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const finished: BrainAgentTurn = {
  outcome: 'finished',
  error: null,
  sessionPath: null,
  rulesChanged: false,
}
const call = () => new AbortController().signal

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
  return { host: { folder: '/made-up/brain/Brain', turn }, turn, ownerDone }
}

it('a change the owner asks for while Defrag waits for their turn belongs to no run', async () => {
  const brain: { service?: BrainService } = {}
  const describe = async (entityId: string, description: string, reason: string) => {
    const result = await brain.service!.agent('edit', {
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
  brain.service = s.service
  await approveRead(s.store, s.service, s.options)
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

/** A read waiting in review, its lane on disk, and a reader that holds until released. */
async function staleRead() {
  const directory = await mkdtemp(join(tmpdir(), 'brain-owner-turn-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'ledger.jsonl')
  await writeFile(file, JSON.stringify({ type: 'session', id: 'ledger', cwd: directory }))
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  const job = seedReview(store, 'ledger', file)
  store.counts = { reads: 1, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
  const refresh: { signal?: AbortSignal; release?: () => void } = {}
  const run = vi.fn(async (read: BrainJob, signal: AbortSignal) => {
    refresh.signal = signal
    await new Promise<void>((resolve) => (refresh.release = resolve))
    store.proposals.set(read.id, {
      ...store.proposals.get(read.id)!,
      computedRevision: store.knowledgeRevision(),
    })
    store.updateJob(read.id, { state: 'review', runStartedAt: null })
  })
  const files = new LaneFiles()
  const queue = new ExtractionQueue({
    store,
    busy: () => false,
    ready: () => true,
    changed: () => {},
    check: (read) => currentReadCheck(store, files, read),
    now: () => 123,
    run,
  })
  cleanups.push(() => queue.dispose())
  cleanups.push(async () => refresh.release?.())
  return { store, job, refresh, run, files, queue, directory }
}

it('the owner’s stale read refreshes inline while Defrag waits, and Stop leaves it running', async () => {
  const read = await staleRead()
  const { store, queue } = read
  const lane = ownerBusyLane()
  const search = new FakeBrainSearch()
  const options = { ...recallOptions(store), directory: read.directory, agent: lane.host }
  const defrag = createDefrag({ store, search, options, queue, changed: () => {} })
  const curator = createCurator({
    store,
    search,
    options,
    queue,
    files: read.files,
    defrag,
    changed: () => {},
    enabled: () => true,
  })
  defrag.start()
  await vi.waitFor(() => expect(lane.turn).toHaveBeenCalled())
  // Brain changed since the read: the owner's turn opens it, stale.
  store.rev++
  const opened = curator.readReview({ jobId: read.job.id }, call()).then(
    () => 'opened',
    (error: unknown) => error,
  )
  // Defrag holds the worker, so the refresh runs inline rather than queueing behind it.
  await vi.waitFor(() => expect(read.run).toHaveBeenCalledOnce())
  defrag.stop()
  expect(read.refresh.signal?.aborted).toBe(false)
  await vi.waitFor(() => expect(store.latestRun()?.state).toBe('stopped'))
  // The worker waits for the owner's refresh before the next read may start.
  expect(queue.defragActive).toBe(true)
  read.refresh.release!()
  expect(await opened).toBe('opened')
  expect(store.job(read.job.id)?.state).toBe('review')
  expect(store.storedProposal(read.job.id)?.computedRevision).toBe(store.knowledgeRevision())
  await vi.waitFor(() => expect(queue.defragActive).toBe(false))
})
