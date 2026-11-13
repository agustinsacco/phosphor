import { afterEach, expect, it, vi } from 'vitest'
import type { BrainSearch } from '@phosphor/memory-engine/types'
import { createSearchClient, type SearchProcess } from './search-client'
import type { FromSearchWorker, ToSearchWorker } from './search-protocol'
import { createSearchWorkerHandler } from './search-worker-handler'

afterEach(() => {
  vi.useRealTimers()
})

function fakeSearch(patch: Partial<BrainSearch> = {}): BrainSearch {
  return {
    refresh: vi.fn(),
    ready: vi.fn(() => true),
    recall: vi.fn(),
    find: vi.fn(),
    nearestEntities: vi.fn((vectors: Float32Array[]) =>
      vectors.map((v) => [{ id: `harbor-${v.length}`, score: v[0]! }]),
    ),
    nearestMemories: vi.fn(() => []),
    close: vi.fn(),
    ...patch,
  }
}

/** A process that runs the real worker handler on the next tick, like a utility process. */
function host(open: (path: string) => BrainSearch = () => fakeSearch(), hang = false) {
  const sent: ToSearchWorker[][] = []
  const processes: { exit(): void; killed: boolean; hang: boolean }[] = []
  const spawn = vi.fn((): SearchProcess => {
    const inbox: ToSearchWorker[] = []
    sent.push(inbox)
    let listener: (message: FromSearchWorker) => void = () => {}
    let onExit: () => void = () => {}
    const state = { exit: () => onExit(), killed: false, hang }
    processes.push(state)
    const handle = createSearchWorkerHandler({ post: (m) => listener(m), open })
    return {
      post: (message) => {
        inbox.push(message)
        if (!state.hang) queueMicrotask(() => handle(message))
      },
      onMessage: (l) => (listener = l),
      onExit: (l) => (onExit = l),
      kill: () => (state.killed = true),
    }
  })
  return { spawn, sent, processes }
}

it('starts the process on the first call, opens the database, then answers in order', async () => {
  const { spawn, sent } = host()
  const client = createSearchClient({ path: '/brain/brain.sqlite', spawn })
  expect(spawn).not.toHaveBeenCalled()
  const vector = Float32Array.of(0.25, 0.5)
  await expect(client.nearestEntities([vector], 5)).resolves.toEqual([
    [{ id: 'harbor-2', score: 0.25 }],
  ])
  await expect(client.ready()).resolves.toBe(true)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(sent[0]!.map((m) => m.type)).toEqual(['open', 'call', 'call'])
  expect(sent[0]![0]).toEqual({ type: 'open', path: '/brain/brain.sqlite' })
})

it('fails only the call that threw, and says why an open failed', async () => {
  const thrower = host(() =>
    fakeSearch({
      find: () => {
        throw new Error('bad query')
      },
    }),
  )
  const client = createSearchClient({ path: 'brain.sqlite', spawn: thrower.spawn })
  await expect(client.find('Harbor', null, 5)).rejects.toThrow('bad query')
  await expect(client.ready()).resolves.toBe(true)

  const broken = host(() => {
    throw new Error('file is not a database')
  })
  const failed = createSearchClient({ path: 'brain.sqlite', spawn: broken.spawn })
  await expect(failed.ready()).rejects.toThrow(
    'Brain search could not open: file is not a database',
  )
})

it('fails pending calls when the process exits and starts a fresh one next time', async () => {
  const { spawn, processes } = host()
  const client = createSearchClient({ path: 'brain.sqlite', spawn })
  await client.ready()
  processes[0]!.hang = true
  const stuck = client.recall({} as never)
  processes[0]!.exit()
  await expect(stuck).rejects.toThrow('Brain search stopped; try again.')
  await expect(client.ready()).resolves.toBe(true)
  expect(spawn).toHaveBeenCalledTimes(2)
})

it('kills a process that misses its deadline, with longer for the first index load', async () => {
  vi.useFakeTimers()
  const log = vi.fn()
  const { spawn, processes } = host(undefined, true)
  const client = createSearchClient({ path: 'brain.sqlite', spawn, timeoutMs: 100, log })
  const refresh = client.refresh()
  const recall = client.recall({} as never)
  const settled = [
    expect(recall).rejects.toThrow('took too long'),
    expect(refresh).rejects.toThrow('took too long'),
  ]
  await vi.advanceTimersByTimeAsync(100)
  await Promise.all(settled)
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining('refresh'))
  expect(processes[0]!.killed).toBe(true)
  expect(log).toHaveBeenCalledWith('Brain search recall missed its 100 ms deadline')
})

it('stops restarting a process that keeps exiting, then tries again a minute later', async () => {
  let at = 0
  const { spawn, processes } = host()
  const client = createSearchClient({ path: 'brain.sqlite', spawn, now: () => at })
  for (let i = 0; i < 3; i++) {
    await client.ready()
    processes[i]!.exit()
  }
  await expect(client.ready()).rejects.toThrow('keeps stopping')
  expect(spawn).toHaveBeenCalledTimes(3)
  at = 60_000
  await expect(client.ready()).resolves.toBe(true)
})

it('closes the search in the process and refuses calls afterwards', async () => {
  const search = fakeSearch()
  const { spawn, sent, processes } = host(() => search)
  const client = createSearchClient({ path: 'brain.sqlite', spawn })
  await client.ready()
  await client.close()
  expect(sent[0]!.at(-1)).toEqual({ type: 'close' })
  expect(processes[0]!.killed).toBe(true)
  await expect(client.ready()).rejects.toThrow('closed')
  expect(spawn).toHaveBeenCalledTimes(1)
})
