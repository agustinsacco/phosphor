import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSearchResult } from '@shared/workspace-search'
import {
  SEARCH_DEBOUNCE_MS,
  useWorkspaceSearchStore,
  workspaceSearch,
} from './workspaceSearchStore'

const invoke = vi.fn()
let ids = 0

const found = (path: string): WorkspaceSearchResult => ({
  files: [
    {
      path,
      matches: [
        {
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 7,
          preview: 'needle',
          previewStart: 0,
          previewEnd: 6,
        },
      ],
    },
  ],
  matchCount: 1,
  searchedFiles: 1,
  skippedFiles: 0,
})

const state = () => workspaceSearch(useWorkspaceSearchStore.getState(), '/ws')
const searches = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:searchWorkspace')
const cancels = () =>
  invoke.mock.calls.filter(([channel]) => channel === 'fs:cancelWorkspaceSearch')

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  vi.stubGlobal('window', { phosphor: { invoke } })
  vi.stubGlobal('crypto', { randomUUID: () => `search-${++ids}` })
  useWorkspaceSearchStore.setState({ byWorkspace: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('workspace search store', () => {
  it('waits for typing to settle, then asks main once with the latest inputs', async () => {
    invoke.mockResolvedValue(found('a.ts'))
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/ws', { query: 'n' })
    store.setInputs('/ws', { query: 'ne' })
    store.setInputs('/ws', { query: 'needle' })
    expect(searches()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(searches()).toHaveLength(1)
    expect(searches()[0]![1]).toMatchObject({
      workspacePath: '/ws',
      query: { text: 'needle', caseSensitive: false, wholeWord: false, regex: false },
      include: undefined,
      exclude: undefined,
    })
    expect(state()).toMatchObject({ searching: false, result: found('a.ts') })
  })

  it('keeps only the newest answer, and cancels the search it replaces', async () => {
    let answerFirst!: (result: WorkspaceSearchResult) => void
    invoke.mockImplementation((channel: string) => {
      if (channel !== 'fs:searchWorkspace') return Promise.resolve()
      if (searches().length === 1) return new Promise((resolve) => (answerFirst = resolve))
      return Promise.resolve(found('new.ts'))
    })
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/ws', { query: 'old' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(state().searching).toBe(true)
    store.setInputs('/ws', { query: 'new' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(cancels()).toEqual([['fs:cancelWorkspaceSearch', 'search-' + String(ids - 1)]])
    answerFirst(found('old.ts'))
    await vi.runAllTimersAsync()
    expect(state().result?.files[0]?.path).toBe('new.ts')
  })

  it('never asks main about an input that does not compile, and clears the old answer', async () => {
    invoke.mockResolvedValue(found('a.ts'))
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/ws', { query: 'needle' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(state().result).not.toBeNull()

    store.toggleOption('/ws', 'regex')
    store.setInputs('/ws', { query: '(' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    store.setInputs('/ws', { query: 'needle', include: '{src' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    // The first search, and the regex toggle's immediate one while 'needle' still stood.
    expect(searches()).toHaveLength(2)
    expect(state().result).toBeNull()
  })

  it('opens with a seed and searches for it at once, and re-focuses on every open', async () => {
    invoke.mockResolvedValue(found('a.ts'))
    const store = useWorkspaceSearchStore.getState()
    store.openSearch('/ws', 'needle')
    expect(state()).toMatchObject({ open: true, query: 'needle' })
    const requests = [state().focusRequest]
    await vi.runAllTimersAsync()
    expect(searches()).toHaveLength(1)
    store.openSearch('/ws')
    requests.push(state().focusRequest)
    store.openSearch('/ws', 'needle')
    requests.push(state().focusRequest)
    expect(new Set(requests).size).toBe(3)
    expect(searches()).toHaveLength(1)
  })

  it('escapes a seed while regex is on, so it finds the text it was', async () => {
    invoke.mockResolvedValue(found('a.ts'))
    const store = useWorkspaceSearchStore.getState()
    store.toggleOption('/ws', 'regex')
    store.openSearch('/ws', 'a.b(c)')
    expect(state().query).toBe('a\\.b\\(c\\)')
    await vi.runAllTimersAsync()
    expect(searches().at(-1)![1]).toMatchObject({ query: { text: 'a\\.b\\(c\\)', regex: true } })
  })

  it('asks for focus back in the explorer on close, and never with a request already made', () => {
    const store = useWorkspaceSearchStore.getState()
    store.openSearch('/ws')
    const opened = state().focusRequest
    store.closeSearch('/ws')
    expect(state().open).toBe(false)
    expect(state().explorerFocusRequest).not.toBe(opened)
    const closed = state().explorerFocusRequest
    // A workspace starting over does not count from zero again.
    useWorkspaceSearchStore.setState({ byWorkspace: {} })
    store.openSearch('/ws')
    expect([opened, closed]).not.toContain(state().focusRequest)
  })

  it('shows a failed search as its reason, without the IPC wrapping', async () => {
    invoke.mockRejectedValue(
      new Error("Error invoking remote method 'fs:searchWorkspace': Error: Workspace is gone"),
    )
    useWorkspaceSearchStore.getState().setInputs('/ws', { query: 'needle' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(state()).toMatchObject({ searching: false, result: { error: 'Workspace is gone' } })
    expect(state().result?.files).toEqual([])
  })

  it('searches at once on a toggle, and drops the search typing had scheduled', async () => {
    invoke.mockResolvedValue(found('a.ts'))
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/ws', { query: 'needle' })
    store.toggleOption('/ws', 'caseSensitive')
    expect(searches()).toHaveLength(1)
    expect(searches()[0]![1]).toMatchObject({ query: { text: 'needle', caseSensitive: true } })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    expect(searches()).toHaveLength(1)
  })

  it('keeps each workspace to its own search: neither cancels nor answers the other', async () => {
    const answers = new Map<string, (result: WorkspaceSearchResult) => void>()
    invoke.mockImplementation((channel: string, request: { workspacePath: string }) => {
      if (channel !== 'fs:searchWorkspace') return Promise.resolve()
      return new Promise((resolve) => answers.set(request.workspacePath, resolve))
    })
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/a', { query: 'needle' })
    store.setInputs('/b', { query: 'needle' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(searches()).toHaveLength(2)
    expect(cancels()).toHaveLength(0)
    answers.get('/b')!(found('b.ts'))
    answers.get('/a')!(found('a.ts'))
    await vi.runAllTimersAsync()
    const slice = (path: string) => workspaceSearch(useWorkspaceSearchStore.getState(), path)
    expect(slice('/a').result?.files[0]?.path).toBe('a.ts')
    expect(slice('/b').result?.files[0]?.path).toBe('b.ts')
    store.closeSearch('/a')
    expect(slice('/b')).toMatchObject({ query: 'needle', searching: false })
  })

  it('drops the globs when the fields holding them are hidden', async () => {
    const store = useWorkspaceSearchStore.getState()
    store.setShowScope('/ws', true)
    store.setInputs('/ws', { include: 'src', exclude: '*.test.ts' })
    store.setShowScope('/ws', false)
    expect(state()).toMatchObject({ showScope: false, include: '', exclude: '' })
  })

  it('folds every file, and unfolds them again', async () => {
    invoke.mockResolvedValue({
      ...found('a.ts'),
      files: [found('a.ts').files[0]!, found('b.ts').files[0]!],
    })
    const store = useWorkspaceSearchStore.getState()
    store.setInputs('/ws', { query: 'needle' })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    store.collapseAll('/ws', true)
    expect(state().collapsed).toEqual({ 'a.ts': true, 'b.ts': true })
    store.toggleCollapsed('/ws', 'a.ts')
    expect(state().collapsed).toEqual({ 'b.ts': true })
    store.collapseAll('/ws', false)
    expect(state().collapsed).toEqual({})
  })
})
