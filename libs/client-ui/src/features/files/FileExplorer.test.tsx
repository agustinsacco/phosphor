// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntry } from '@shared/models'
import { useFilesStore } from '@/stores/files'
import { FileExplorer } from './FileExplorer'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const invoke = vi.fn()
const scrollIntoView = vi.fn()
let root: Root
let container: HTMLDivElement
const entry = (path: string, isDirectory = false): DirEntry => ({
  name: path.split('/').at(-1)!,
  path,
  relativePath: path.slice('/repo/'.length),
  isDirectory,
})
const listings: Record<string, DirEntry[]> = {
  '/repo': [entry('/repo/src', true), entry('/repo/other', true), entry('/repo/a.ts')],
  '/repo/src': [entry('/repo/src/nested', true)],
  '/repo/src/nested': [entry('/repo/src/nested/b.ts')],
}
const row = (path: string) => container.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)
const open = async (path: string) => {
  await act(async () => useFilesStore.getState().openFile('/repo', path))
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  invoke
    .mockReset()
    .mockImplementation(async (channel: string, _workspace: string, dir: string) => {
      if (channel === 'fs:readDir') return listings[dir] ?? []
      if (channel === 'fs:readFile') return { content: 'text', size: 4, mtimeMs: 1 }
      return {}
    })
  Object.assign(window, { phosphor: { invoke } })
  useFilesStore.setState({ entries: {}, expanded: {}, byWorkspace: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('reveals lazy ancestors, selects and scrolls the active file without moving focus', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  await act(async () => row('/repo/a.ts')!.click())
  row('/repo/a.ts')!.focus()
  const focused = document.activeElement
  await open('/repo/src/nested/b.ts')
  expect(row('/repo/src')?.getAttribute('aria-expanded')).toBe('true')
  expect(row('/repo/src/nested')?.getAttribute('aria-expanded')).toBe('true')
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-current')).toBe('true')
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-pressed')).toBe('true')
  expect(row('/repo/a.ts')?.getAttribute('aria-pressed')).toBe('false')
  expect(scrollIntoView.mock.instances.at(-1)).toBe(row('/repo/src/nested/b.ts'))
  expect(document.activeElement).toBe(focused)
  expect(invoke.mock.calls.filter(([c]) => c === 'fs:readDir').map((args) => args[2])).toEqual([
    '/repo',
    '/repo/src',
    '/repo/src/nested',
  ])

  // A manual collapse stays collapsed until another navigation, even to the same file.
  await act(async () => row('/repo/src')!.click())
  expect(row('/repo/src/nested/b.ts')).toBeNull()
  await open('/repo/src/nested/b.ts')
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => useFilesStore.getState().setActive('/repo', '/repo/a.ts'))
  expect(row('/repo/a.ts')?.getAttribute('aria-current')).toBe('true')
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-pressed')).toBe('false')
})

it('preserves manual multi-selection until the next file navigation', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  await open('/repo/a.ts')
  act(() => {
    row('/repo/other')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  })
  expect(row('/repo/a.ts')?.getAttribute('aria-pressed')).toBe('true')
  expect(row('/repo/other')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => useFilesStore.getState().refreshDir('/repo', '/repo'))
  expect(row('/repo/other')?.getAttribute('aria-pressed')).toBe('true')
  await open('/repo/a.ts')
  expect(row('/repo/other')?.getAttribute('aria-pressed')).toBe('false')
})

const press = async (key: string, options: KeyboardEventInit = {}) => {
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    ),
  )
}

it('walks to parents and first children, and collapses before moving up', async () => {
  await open('/repo/src/nested/b.ts')
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  row('/repo/src/nested/b.ts')!.focus()
  await press('ArrowLeft')
  expect(document.activeElement).toBe(row('/repo/src/nested'))
  await press('ArrowRight')
  expect(document.activeElement).toBe(row('/repo/src/nested/b.ts'))
  await press('ArrowLeft')
  await press('ArrowLeft')
  expect(row('/repo/src/nested')?.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(row('/repo/src/nested'))
  await press('ArrowLeft')
  expect(document.activeElement).toBe(row('/repo/src'))
})

it('extends and shrinks a keyboard range from a stable anchor', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  row('/repo/src')!.focus()
  await press('ArrowDown', { shiftKey: true })
  expect(container.querySelectorAll('[data-path][aria-pressed="true"]')).toHaveLength(2)
  await press('ArrowDown', { shiftKey: true })
  expect(container.querySelectorAll('[data-path][aria-pressed="true"]')).toHaveLength(3)
  await press('ArrowUp', { shiftKey: true })
  expect(container.querySelectorAll('[data-path][aria-pressed="true"]')).toHaveLength(2)
  expect(row('/repo/src')?.getAttribute('aria-pressed')).toBe('true')
})

it('starts a keyboard range at the new file after editor navigation', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  await act(async () => row('/repo/a.ts')!.click())
  await open('/repo/src/nested/b.ts')
  row('/repo/src/nested/b.ts')!.focus()
  await press('ArrowDown', { shiftKey: true })
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-pressed')).toBe('true')
  expect(row('/repo/other')?.getAttribute('aria-pressed')).toBe('true')
  expect(row('/repo/a.ts')?.getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelectorAll('[data-path][aria-pressed="true"]')).toHaveLength(2)
})

it('finds visible filenames by typing without opening the file', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  container.querySelector<HTMLElement>('[data-testid="file-explorer"]')!.focus()
  await press('s')
  await press('r')
  expect(document.activeElement).toBe(row('/repo/src'))
  expect(row('/repo/src')?.getAttribute('aria-expanded')).toBe('false')
  await press('a', { isComposing: true })
  expect(document.activeElement).toBe(row('/repo/src'))
})

it('collapses this workspace only and explicitly reveals the active file again', async () => {
  await open('/repo/src/nested/b.ts')
  useFilesStore.setState({ expanded: { '/other/src': true } })
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-tooltip="Collapse all folders"]')!.click(),
  )
  expect(row('/repo/src/nested/b.ts')).toBeNull()
  expect(useFilesStore.getState().expanded['/other/src']).toBe(true)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-tooltip="Reveal active file"]')!.click(),
  )
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-current')).toBe('true')
})

it('reveals a file opened while the explorer was unmounted', async () => {
  await open('/repo/src/nested/b.ts')
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  expect(row('/repo/src/nested/b.ts')?.getAttribute('aria-pressed')).toBe('true')
})

it('does not expand unrelated paths or bypass filtered listings', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  await open('/repo-other/src/b.ts')
  await open('/repo/.hidden/b.ts')
  expect(useFilesStore.getState().expanded).toEqual({})
  expect(invoke.mock.calls.filter(([c]) => c === 'fs:readDir')).toHaveLength(1)
})

it('stops an old reveal when navigation changes during a directory read', async () => {
  await act(async () => root.render(<FileExplorer workspacePath="/repo" />))
  let finish!: (entries: DirEntry[]) => void
  invoke.mockImplementation(async (channel: string, _workspace: string, dir: string) => {
    if (channel === 'fs:readDir' && dir === '/repo/src')
      return new Promise<DirEntry[]>((resolve) => {
        finish = resolve
      })
    return { content: 'text', size: 4, mtimeMs: 1 }
  })
  await open('/repo/src/nested/b.ts')
  await open('/repo/a.ts')
  await act(async () => finish(listings['/repo/src']!))
  expect(useFilesStore.getState().expanded['/repo/src/nested']).toBeUndefined()
  expect(row('/repo/a.ts')?.getAttribute('aria-pressed')).toBe('true')
})
