import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SEARCH_OPTIONS } from '@shared/text-search'
import {
  EMPTY_SEARCH_RESULT,
  SEARCH_TIME_LIMIT_MS,
  type WorkspaceSearchRequest,
} from '@shared/workspace-search'
import type {
  SearchJob,
  SearchWorkerMessage,
} from '@phosphor/session-runtime/files/workspace-search'

/** A worker that does nothing until the test speaks for it. */
class FakeWorker extends EventEmitter {
  readonly job: SearchJob
  terminated = false
  constructor(options: { workerData: SearchJob }) {
    super()
    this.job = options.workerData
  }
  post(message: SearchWorkerMessage): void {
    this.emit('message', message)
  }
  terminate(): Promise<number> {
    this.terminated = true
    // As a real worker does, once it is gone.
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }
}

const { workers, listFiles } = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  listFiles: vi.fn(),
}))

vi.mock('./workspace-search-worker?nodeWorker', () => ({
  default: (options: { workerData: SearchJob }) => {
    const worker = new FakeWorker(options)
    workers.push(worker)
    return worker
  },
}))
vi.mock('./list-files', () => ({ listWorkspaceFileList: listFiles }))

const { cancelWorkspaceSearch, searchWorkspace } = await import('./workspace-search-service')

let nextSender = 1
function sender(): WebContents & EventEmitter {
  return Object.assign(new EventEmitter(), { id: nextSender++ }) as WebContents & EventEmitter
}

const workspacePath = tmpdir()

function request(overrides: Partial<WorkspaceSearchRequest> = {}): WorkspaceSearchRequest {
  return {
    searchId: 's1',
    workspacePath,
    query: { ...DEFAULT_SEARCH_OPTIONS, text: 'needle' },
    ...overrides,
  }
}

/** Let the listing resolve and the worker start. */
async function started(count = workers.length + 1): Promise<FakeWorker> {
  await vi.waitFor(() => expect(workers).toHaveLength(count))
  return workers.at(-1)!
}

const match = { line: 1, column: 1, endLine: 1, endColumn: 7, preview: 'needle' }
const found = (path: string) => ({
  path,
  matches: [{ ...match, previewStart: 0, previewEnd: 6 }],
})

beforeEach(() => {
  workers.length = 0
  listFiles.mockReset()
  listFiles.mockResolvedValue({ files: ['b.txt', 'a.txt'], truncated: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('searchWorkspace', () => {
  it('refuses a request that is not well formed', async () => {
    const window = sender()
    for (const bad of [
      null,
      'needle',
      { ...request(), workspacePath: 'relative/path' },
      { ...request(), searchId: '' },
      { ...request(), searchId: 'x'.repeat(101) },
      { ...request(), query: { text: 'needle' } },
      { ...request(), include: 3 },
    ]) {
      await expect(searchWorkspace(window, bad)).rejects.toThrow('Invalid search request')
    }
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('answers an empty or broken query without listing or starting a worker', async () => {
    const window = sender()
    const empty = await searchWorkspace(
      window,
      request({ query: { ...request().query, text: '' } }),
    )
    expect(empty).toEqual(EMPTY_SEARCH_RESULT)
    const broken = await searchWorkspace(
      window,
      request({ query: { ...request().query, text: '(', regex: true } }),
    )
    expect(broken).toEqual({ ...EMPTY_SEARCH_RESULT, error: 'Unterminated group' })
    expect(listFiles).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
  })

  it('hands the worker the sorted listing, and gathers its batches', async () => {
    listFiles.mockResolvedValue({ files: ['b.txt', 'a.txt'], truncated: true })
    const pending = searchWorkspace(sender(), request({ include: 'src' }))
    const worker = await started()
    expect(worker.job).toMatchObject({
      root: workspacePath,
      files: ['a.txt', 'b.txt'],
      include: 'src',
    })
    worker.post({ type: 'batch', files: [found('a.txt')], searchedFiles: 1, skippedFiles: 0 })
    worker.post({ type: 'batch', files: [found('b.txt')], searchedFiles: 2, skippedFiles: 0 })
    worker.post({
      type: 'done',
      summary: { matchCount: 2, searchedFiles: 2, skippedFiles: 0 },
    })
    const result = await pending
    expect(result.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(result).toMatchObject({ matchCount: 2, searchedFiles: 2, moreFiles: true })
    expect(worker.terminated).toBe(true)
  })

  it("stops a window's search when it starts another, keeping what the first found", async () => {
    const window = sender()
    const first = searchWorkspace(window, request({ searchId: 'first' }))
    const firstWorker = await started()
    firstWorker.post({ type: 'batch', files: [found('a.txt')], searchedFiles: 1, skippedFiles: 0 })
    const second = searchWorkspace(window, request({ searchId: 'second' }))
    expect(await first).toMatchObject({ stopped: 'cancelled', matchCount: 1, searchedFiles: 1 })
    expect(firstWorker.terminated).toBe(true)
    const secondWorker = await started()
    secondWorker.post({
      type: 'done',
      summary: { matchCount: 0, searchedFiles: 2, skippedFiles: 0 },
    })
    expect((await second).stopped).toBeUndefined()
  })

  it('leaves other windows searching', async () => {
    const one = searchWorkspace(sender(), request())
    const oneWorker = await started()
    const two = searchWorkspace(sender(), request())
    const twoWorker = await started()
    expect(oneWorker.terminated).toBe(false)
    for (const worker of [oneWorker, twoWorker]) {
      worker.post({ type: 'done', summary: { matchCount: 0, searchedFiles: 2, skippedFiles: 0 } })
    }
    expect((await one).stopped).toBeUndefined()
    expect((await two).stopped).toBeUndefined()
  })

  it('cancels only the search it names, from the window that started it', async () => {
    const window = sender()
    const pending = searchWorkspace(window, request({ searchId: 'current' }))
    const worker = await started()
    cancelWorkspaceSearch(window, 'stale')
    cancelWorkspaceSearch(sender(), 'current')
    expect(worker.terminated).toBe(false)
    cancelWorkspaceSearch(window, 'current')
    expect(await pending).toMatchObject({ stopped: 'cancelled' })
    expect(worker.terminated).toBe(true)
  })

  it('stops a search that runs past the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = searchWorkspace(sender(), request())
    const worker = await started()
    worker.post({ type: 'batch', files: [found('a.txt')], searchedFiles: 1, skippedFiles: 0 })
    vi.advanceTimersByTime(SEARCH_TIME_LIMIT_MS)
    expect(await pending).toMatchObject({ stopped: 'time', matchCount: 1 })
    expect(worker.terminated).toBe(true)
  })

  it('counts the listing against the time limit, and stops it too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let listingSignal: AbortSignal | undefined
    listFiles.mockImplementation(
      (_root: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          listingSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    const pending = searchWorkspace(sender(), request())
    await vi.waitFor(() => expect(listingSignal).toBeDefined())
    vi.advanceTimersByTime(SEARCH_TIME_LIMIT_MS)
    expect(await pending).toEqual({ ...EMPTY_SEARCH_RESULT, stopped: 'time' })
    expect(listingSignal!.aborted).toBe(true)
    expect(workers).toHaveLength(0)
  })

  it('stops the search when its window closes', async () => {
    const window = sender()
    const pending = searchWorkspace(window, request())
    const worker = await started()
    window.emit('destroyed')
    expect(await pending).toMatchObject({ stopped: 'cancelled' })
    expect(worker.terminated).toBe(true)
  })

  it('reports a worker that fails or dies', async () => {
    const failed = searchWorkspace(sender(), request())
    ;(await started()).post({ type: 'failed', error: 'boom' })
    expect(await failed).toMatchObject({ error: 'boom' })

    const died = searchWorkspace(sender(), request())
    ;(await started()).emit('exit', 1)
    expect(await died).toMatchObject({ error: 'The search stopped unexpectedly.' })
  })

  it('refuses a workspace that is not a folder', async () => {
    const path = `${workspacePath}/phosphor-no-such-folder-${process.pid}`
    await expect(searchWorkspace(sender(), request({ workspacePath: path }))).rejects.toThrow()
    expect(listFiles).not.toHaveBeenCalled()
  })
})
