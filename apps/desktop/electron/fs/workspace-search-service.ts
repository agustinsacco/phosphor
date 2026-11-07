/// <reference types="electron-vite/node" />
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { WebContents } from 'electron'
import {
  compileSearch,
  EMPTY_SEARCH_RESULT,
  SEARCH_TIME_LIMIT_MS,
  type FileSearchResult,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
} from '@shared/workspace-search'
import { listWorkspaceFileList } from './list-files'
import type {
  SearchJob,
  SearchWorkerMessage,
} from '@phosphor/session-runtime/files/workspace-search'
import createSearchWorker from './workspace-search-worker?nodeWorker'

/**
 * The Files pane's workspace search (`fs:searchWorkspace`).
 *
 * Each search runs in its own worker thread. The query is the user's own
 * regex, and a regex can backtrack for minutes on one line; on main's thread
 * that would freeze every window. A worker is terminated mid-match instead:
 * by the time limit, by a cancel, or by the next search from the same window —
 * each keystroke supersedes the last, so at most one runs per window. The
 * same signal stops the file listing before it, killing git.
 *
 * A search that stops early still resolves, with what it found and why it
 * stopped, so the pane can show partial results rather than none.
 */

/** The worker's heap ceiling. It holds one read batch of text at a time. */
const WORKER_HEAP_MB = 512
const MAX_SEARCH_ID_LENGTH = 100

type StopReason = 'time' | 'cancelled'

interface RunningSearch {
  searchId: string
  controller: AbortController
}

/** Each window's running search, by `WebContents` id. */
const running = new Map<number, RunningSearch>()
const watchedSenders = new WeakSet<WebContents>()

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/**
 * The renderer's request, checked field by field: it crosses a trust boundary.
 * Lengths are `compileSearch`'s to judge, so a long query gets a reason back.
 */
function isRequest(value: unknown): value is WorkspaceSearchRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  const query = request.query as Record<string, unknown> | null | undefined
  return (
    typeof request.searchId === 'string' &&
    request.searchId.length > 0 &&
    request.searchId.length <= MAX_SEARCH_ID_LENGTH &&
    typeof request.workspacePath === 'string' &&
    isAbsolute(request.workspacePath) &&
    !!query &&
    typeof query === 'object' &&
    typeof query.text === 'string' &&
    typeof query.caseSensitive === 'boolean' &&
    typeof query.wholeWord === 'boolean' &&
    typeof query.regex === 'boolean' &&
    isOptionalString(request.include) &&
    isOptionalString(request.exclude)
  )
}

function stopReason(signal: AbortSignal): StopReason {
  return signal.reason === 'time' ? 'time' : 'cancelled'
}

/** Stop `sender`'s search `searchId`, if it is still the one running. */
export function cancelWorkspaceSearch(sender: WebContents, searchId: string): void {
  const search = running.get(sender.id)
  if (search?.searchId === searchId) search.controller.abort('cancelled' satisfies StopReason)
}

export async function searchWorkspace(
  sender: WebContents,
  request: unknown,
): Promise<WorkspaceSearchResult> {
  if (!isRequest(request)) throw new Error('Invalid search request')
  const owner = sender.id
  if (!watchedSenders.has(sender)) {
    watchedSenders.add(sender)
    sender.once('destroyed', () => running.get(owner)?.controller.abort('cancelled'))
  }
  running.get(owner)?.controller.abort('cancelled' satisfies StopReason)
  const search: RunningSearch = { searchId: request.searchId, controller: new AbortController() }
  running.set(owner, search)
  const { signal } = search.controller
  const timer = setTimeout(
    () => search.controller.abort('time' satisfies StopReason),
    SEARCH_TIME_LIMIT_MS,
  )
  try {
    const job: Omit<SearchJob, 'root' | 'files'> = {
      query: {
        text: request.query.text,
        caseSensitive: request.query.caseSensitive,
        wholeWord: request.query.wholeWord,
        regex: request.query.regex,
      },
      include: request.include,
      exclude: request.exclude,
    }
    // Bad input answers at once, without listing a file or starting a worker.
    const compiled = compileSearch(job)
    if (compiled.status === 'empty') return EMPTY_SEARCH_RESULT
    if (compiled.status === 'invalid') return { ...EMPTY_SEARCH_RESULT, error: compiled.error }

    const root = resolve(request.workspacePath)
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a folder: ${root}`)
    let list
    try {
      list = await listWorkspaceFileList(root, signal)
    } catch (error) {
      if (signal.aborted) return { ...EMPTY_SEARCH_RESULT, stopped: stopReason(signal) }
      throw error
    }
    if (signal.aborted) return { ...EMPTY_SEARCH_RESULT, stopped: stopReason(signal) }
    const result = await runWorker({ ...job, root, files: list.files.sort() }, signal)
    return list.truncated ? { ...result, moreFiles: true } : result
  } finally {
    clearTimeout(timer)
    if (running.get(owner) === search) running.delete(owner)
  }
}

function runWorker(job: SearchJob, signal: AbortSignal): Promise<WorkspaceSearchResult> {
  return new Promise((settle) => {
    const files: FileSearchResult[] = []
    let matchCount = 0
    let searchedFiles = 0
    let skippedFiles = 0
    let settled = false
    const worker = createSearchWorker({
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    })
    const finish = (end: Partial<WorkspaceSearchResult>): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      void worker.terminate()
      settle({ files, matchCount, searchedFiles, skippedFiles, ...end })
    }
    const onAbort = (): void => finish({ stopped: stopReason(signal) })
    signal.addEventListener('abort', onAbort)

    worker.on('message', (message: SearchWorkerMessage) => {
      switch (message.type) {
        case 'batch':
          files.push(...message.files)
          for (const file of message.files) matchCount += file.matches.length
          searchedFiles = message.searchedFiles
          skippedFiles = message.skippedFiles
          break
        case 'done':
          finish(message.summary)
          break
        case 'failed':
          finish({ error: message.error })
          break
      }
    })
    worker.on('error', (error: unknown) =>
      finish({ error: error instanceof Error ? error.message : String(error) }),
    )
    worker.on('exit', () => finish({ error: 'The search stopped unexpectedly.' }))
  })
}
