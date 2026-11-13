import { expect, it, vi } from 'vitest'
import type { BrainSearch } from '@phosphor/memory-engine/types'
import type { FromSearchWorker } from './search-protocol'
import { createSearchWorkerHandler } from './search-worker-handler'

function search(): BrainSearch {
  return {
    refresh: vi.fn(),
    ready: vi.fn(() => false),
    recall: vi.fn(),
    find: vi.fn(),
    nearestEntities: vi.fn(),
    nearestMemories: vi.fn(),
    close: vi.fn(),
  }
}

it('answers before open with an error, and reopening closes the old connection', () => {
  const posted: FromSearchWorker[] = []
  const opened: BrainSearch[] = []
  const handle = createSearchWorkerHandler({
    post: (m) => posted.push(m),
    open: () => {
      const next = search()
      opened.push(next)
      return next
    },
  })
  handle({ type: 'call', id: 1, method: 'ready', args: [] })
  handle({ type: 'open', path: 'a.sqlite' })
  handle({ type: 'open', path: 'a.sqlite' })
  handle({ type: 'call', id: 2, method: 'ready', args: [] })
  expect(posted).toEqual([
    { type: 'error', id: 1, error: 'Brain search is not open.' },
    { type: 'result', id: 2, value: false },
  ])
  expect(opened[0]!.close).toHaveBeenCalled()
  expect(opened[1]!.close).not.toHaveBeenCalled()
})

it('refuses methods outside the search contract, including close as a call', () => {
  const posted: FromSearchWorker[] = []
  const open = search()
  const handle = createSearchWorkerHandler({ post: (m) => posted.push(m), open: () => open })
  handle({ type: 'open', path: 'a.sqlite' })
  handle({ type: 'call', id: 1, method: 'close' as never, args: [] })
  handle({ type: 'call', id: 2, method: 'constructor' as never, args: [] })
  expect(posted.map((m) => m.type)).toEqual(['error', 'error'])
  expect(open.close).not.toHaveBeenCalled()
  handle({ type: 'close' })
  handle({ type: 'call', id: 3, method: 'ready', args: [] })
  expect(open.close).toHaveBeenCalledTimes(1)
  expect(posted.at(-1)).toEqual({ type: 'error', id: 3, error: 'Brain search is closed.' })
})
