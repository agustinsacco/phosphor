// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LineMatch, WorkspaceSearchResult } from '@shared/workspace-search'
import { FilesPane } from './FilesPane'
import { useWorkspaceSearchStore, type workspaceSearch } from './workspaceSearchStore'

const { openFileInWorkspace } = vi.hoisted(() => ({
  openFileInWorkspace: vi.fn((..._args: unknown[]) => Promise.resolve()),
}))

vi.mock('@/stores/layout', () => ({ openFileInWorkspace }))
vi.mock('@/stores/files', () => ({
  useFilesStore: { getState: () => ({ pollWorkspace: () => Promise.resolve() }) },
}))
vi.mock('./fileActions', () => ({ runFileAction: () => {} }))
// The explorer and the editor have suites of their own; here they only need to be there.
vi.mock('./FileExplorer', async () => {
  const { createElement } = await import('react')
  return {
    FileExplorer: () => createElement('div', { tabIndex: 0, 'data-testid': 'file-explorer' }),
  }
})
vi.mock('./EditorPane', () => ({ EditorPane: () => null }))
vi.mock('react-resizable-panels', async () => {
  const { createElement } = await import('react')
  const box = ({ children }: { children?: React.ReactNode }) => createElement('div', null, children)
  return { PanelGroup: box, Panel: box, PanelResizeHandle: () => null }
})

const WS = '/ws'
const invoke = vi.fn()
const scrollIntoView = vi.fn()

const match = (line: number, preview: string): LineMatch => ({
  line,
  column: 1,
  endLine: line,
  endColumn: 7,
  preview,
  previewStart: 0,
  previewEnd: 6,
})

/** Rows on screen: a.ts, its lines 1 and 4, src/b.ts, its line 2. */
const RESULT: WorkspaceSearchResult = {
  files: [
    { path: 'a.ts', matches: [match(1, 'needle one'), match(4, '  needle two')] },
    { path: 'src/b.ts', matches: [match(2, 'needle three')] },
  ],
  matchCount: 3,
  searchedFiles: 2,
  skippedFiles: 0,
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<FilesPane workspacePath={WS} />))
}

/** Open the search on an answer already in, as if typed and searched. */
function show(fields: Partial<ReturnType<typeof workspaceSearch>> = {}): void {
  act(() => {
    useWorkspaceSearchStore.getState().openSearch(WS)
    useWorkspaceSearchStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [WS]: { ...s.byWorkspace[WS]!, query: 'needle', result: RESULT, ...fields },
      },
    }))
  })
}

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const input = () => q('workspace-search-input') as HTMLInputElement
const list = () => q('workspace-search-results')!
const status = () => q('workspace-search-status')!
const fileRow = (path: string) => list().querySelector<HTMLElement>(`[data-search-file="${path}"]`)
const lineRow = (line: number) => list().querySelector<HTMLElement>(`[data-search-line="${line}"]`)
const selectedRow = () => list().querySelector<HTMLElement>('[aria-selected="true"]')
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const searches = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:searchWorkspace')

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  })
}

function mouse(target: HTMLElement, type: 'mousedown' | 'mouseup' | 'click'): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = scrollIntoView
})

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(channel === 'fs:searchWorkspace' ? RESULT : undefined),
  )
  openFileInWorkspace.mockClear()
  scrollIntoView.mockClear()
  ;(window as unknown as { phosphor: unknown }).phosphor = {
    invoke,
    onFsChanged: () => () => {},
  }
  useWorkspaceSearchStore.setState({ byWorkspace: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('WorkspaceSearch', () => {
  it('walks the results from the keyboard: in from the field, open, fold, and back out', () => {
    render()
    show()
    expect(document.activeElement).toBe(input())

    press(input(), 'ArrowDown')
    expect(document.activeElement).toBe(list())
    expect(selectedRow()).toBe(fileRow('a.ts'))
    expect(list().getAttribute('aria-activedescendant')).toBe(fileRow('a.ts')!.id)

    press(list(), 'ArrowDown')
    press(list(), 'ArrowDown')
    expect(selectedRow()).toBe(lineRow(4))
    press(list(), ' ')
    expect(openFileInWorkspace).toHaveBeenLastCalledWith(WS, 'a.ts', {
      line: 4,
      column: 1,
      endLine: 4,
      endColumn: 7,
      focus: false,
    })
    press(list(), 'Enter')
    expect(openFileInWorkspace).toHaveBeenLastCalledWith(
      WS,
      'a.ts',
      expect.objectContaining({ line: 4, focus: true }),
    )

    // ← goes up to the file, then folds it; ↓ steps over what is folded.
    press(list(), 'ArrowLeft')
    expect(selectedRow()).toBe(fileRow('a.ts'))
    press(list(), 'ArrowLeft')
    expect(fileRow('a.ts')!.getAttribute('aria-expanded')).toBe('false')
    expect(lineRow(1)).toBeNull()
    press(list(), 'ArrowDown')
    expect(selectedRow()).toBe(fileRow('src/b.ts'))
    press(list(), 'End')
    expect(selectedRow()).toBe(lineRow(2))
    press(list(), 'Home')
    press(list(), 'ArrowRight')
    expect(fileRow('a.ts')!.getAttribute('aria-expanded')).toBe('true')

    press(list(), 'ArrowUp')
    expect(document.activeElement).toBe(input())
  })

  it('leaves a click its own row: focus from the pointer moves no cursor and scrolls nothing', () => {
    render()
    show()
    act(() => input().blur())
    const row = lineRow(2)!
    act(() => {
      mouse(row, 'mousedown')
      // What the browser does on the press: the list is the focusable ancestor.
      list().focus()
    })
    expect(document.activeElement).toBe(list())
    expect(selectedRow()).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() => {
      mouse(row, 'mouseup')
      mouse(row, 'click')
    })
    expect(selectedRow()).toBe(row)
    expect(openFileInWorkspace).toHaveBeenLastCalledWith(
      WS,
      'src/b.ts',
      expect.objectContaining({ line: 2, focus: false }),
    )
  })

  it('puts the cursor on the first row when the list is reached by keyboard', () => {
    render()
    show()
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      list().focus()
    })
    expect(selectedRow()).toBe(fileRow('a.ts'))
  })

  it('keeps the cursor on its row as files above it fold, and starts over on a new answer', () => {
    render()
    show()
    press(input(), 'ArrowDown')
    press(list(), 'End')
    expect(selectedRow()).toBe(lineRow(2))

    const store = useWorkspaceSearchStore.getState()
    act(() => store.toggleCollapsed(WS, 'a.ts'))
    expect(selectedRow()).toBe(lineRow(2))
    // Its own match folded away, the cursor stays on the file it was in.
    act(() => store.collapseAll(WS, true))
    expect(selectedRow()).toBe(fileRow('src/b.ts'))

    Object.defineProperty(list(), 'scrollTop', { value: 120, writable: true, configurable: true })
    act(() => {
      useWorkspaceSearchStore.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [WS]: { ...s.byWorkspace[WS]!, result: { ...RESULT } } },
      }))
    })
    expect(selectedRow()).toBeNull()
    expect(list().scrollTop).toBe(0)
  })

  it('hands focus back to the explorer when Escape or ✕ closes the search', () => {
    render()
    show()
    press(input(), 'ArrowDown')
    press(list(), 'Escape')
    expect(document.activeElement).toBe(input())

    press(input(), 'Escape')
    expect(q('workspace-search')).toBeNull()
    expect(document.activeElement).toBe(q('file-explorer'))

    act(() => useWorkspaceSearchStore.getState().openSearch(WS))
    expect(document.activeElement).toBe(input())
    act(() => button('Back to the explorer (Esc)').click())
    expect(document.activeElement).toBe(q('file-explorer'))

    // Coming back to the pane later is not closing the search again.
    act(() => (document.activeElement as HTMLElement).blur())
    act(() => root!.unmount())
    root = createRoot(container!)
    act(() => root!.render(<FilesPane workspacePath={WS} />))
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves Enter and Escape to an IME that is composing', async () => {
    render()
    show()
    press(input(), 'Enter', { isComposing: true })
    press(input(), 'Escape', { keyCode: 229 })
    expect(searches()).toHaveLength(0)
    expect(q('workspace-search')).not.toBeNull()

    press(input(), 'Enter')
    expect(searches()).toHaveLength(1)
    await act(async () => {})
  })

  it('marks the field at fault and points it at the reason; the scope toggle says it is open', () => {
    render()
    show({ showScope: true, include: '{src', result: null })
    expect(button('Files to include or exclude').getAttribute('aria-expanded')).toBe('true')

    const include = document.querySelector<HTMLInputElement>('input[placeholder^="e.g. src"]')!
    expect(include.getAttribute('aria-invalid')).toBe('true')
    expect(include.getAttribute('aria-describedby')).toBe(status().id)
    expect(status().textContent).not.toBe('')
    expect(input().getAttribute('aria-invalid')).toBe('false')
    expect(input().hasAttribute('aria-describedby')).toBe(false)

    act(() => button('Files to include or exclude').click())
    expect(button('Files to include or exclude').getAttribute('aria-expanded')).toBe('false')
  })

  it('names each row for a screen reader by what it holds', () => {
    render()
    show()
    expect(fileRow('src/b.ts')!.getAttribute('aria-label')).toBe('src/b.ts, 1 result')
    expect(lineRow(4)!.getAttribute('aria-label')).toBe('Line 4: needle two')
  })
})
