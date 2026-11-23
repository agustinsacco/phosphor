import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from '../service'
import { recallOptions } from '../__fixtures__/options'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import type { BrainAgentHost, BrainAgentTurn } from '../types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const finished: BrainAgentTurn = {
  outcome: 'finished',
  error: null,
  sessionPath: null,
  rulesChanged: true,
}
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'brain-defrag-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function setup(withHost = true) {
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  store.counts = { reads: 0, entities: 1, repeats: 0, conflicts: 0, flags: 1 }
  const search = new FakeBrainSearch()
  const turn = vi.fn<BrainAgentHost['turn']>(async () => finished)
  const options = {
    ...recallOptions(store),
    directory: await directory(),
    openSearch: () => search,
    ...(withHost ? { agent: { folder: '/made-up/brain/Brain', turn } } : {}),
  }
  const service = await createBrainService(options)
  cleanups.push(() => service.dispose())
  return { store, search, service, turn }
}

it('reports an unfinished run from the last app run as interrupted, at startup', async () => {
  const store = new FakeAgentStore()
  store.createRun()
  store.runs[0]!.state = 'running'
  const options = {
    ...recallOptions(store),
    directory: await directory(),
    agent: { folder: '/b', turn: vi.fn() },
  }
  const service = await createBrainService(options)
  cleanups.push(() => service.dispose())
  expect(store.interrupted).toEqual(['Phosphor closed during Defrag.'])
  expect((await service.api.status()).agent.run).toMatchObject({
    state: 'failed',
    error: 'Phosphor closed during Defrag.',
  })
})

it('status carries the waiting counts, the latest run and the Brain folder', async () => {
  const s = await setup()
  const status = await s.service.api.status()
  expect(status.agent).toEqual({
    waiting: { reads: 0, entities: 1, repeats: 0, conflicts: 0, flags: 1 },
    run: null,
    folder: '/made-up/brain/Brain',
  })
  expect(status.agent.run).toBeNull()
  const desktopless = await setup(false)
  expect((await desktopless.service.api.status()).agent.folder).toBeNull()
  await expect(desktopless.service.api.defrag()).rejects.toThrow('Defrag runs on Desktop.')
})

it('Defrag runs through the service and its channels start and stop it', async () => {
  const s = await setup()
  const queued = await s.service.api.defrag()
  expect(queued.agent.run?.state).toMatch(/queued|running/)
  await vi.waitFor(async () =>
    expect((await s.service.api.status()).agent.run).toMatchObject({
      state: 'done',
      total: 2,
      rulesChanged: true,
    }),
  )
  expect(s.turn).toHaveBeenCalledWith(
    'Defrag. 2 waiting: 1 person or thing, 1 flag. Start with brain_waiting.',
    expect.any(AbortSignal),
    { opened: expect.any(Function), sending: expect.any(Function) },
  )
  expect((await s.service.api.status()).agent.run?.state).toBe('done')

  s.turn.mockImplementationOnce(
    (_message: string, signal: AbortSignal) =>
      new Promise<BrainAgentTurn>((resolve) =>
        signal.addEventListener('abort', () => resolve({ ...finished, outcome: 'stopped' })),
      ),
  )
  await s.service.api.defrag()
  await vi.waitFor(() => expect(s.turn).toHaveBeenCalledTimes(2))
  await s.service.api.defragStop()
  await vi.waitFor(async () =>
    expect((await s.service.api.status()).agent.run?.state).toBe('stopped'),
  )
})

it('Undo run reverses the run, refreshes search and says what stayed', async () => {
  const s = await setup()
  s.store.undone = { undone: 4, kept: 1 }
  const refresh = vi.spyOn(s.search, 'refresh')
  const result = await s.service.api.undoRun('run-7')
  expect(result).toMatchObject({ undone: 4, kept: 1, agent: expect.any(Object) })
  expect(s.store.calls.at(-1)).toMatchObject({ method: 'undoRun', args: ['run-7'] })
  expect(refresh).toHaveBeenCalled()

  const running = s.store.createRun()
  s.store.runs.at(-1)!.state = 'running'
  await expect(s.service.api.undoRun(running.id)).rejects.toThrow(
    'Wait for Defrag to finish before undoing its run.',
  )
})
