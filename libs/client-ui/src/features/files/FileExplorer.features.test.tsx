// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntry } from '@shared/models'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { useFilesStore } from '@/stores/files'
import { FileExplorer } from './FileExplorer'
import { localFilesSource, type FilesSource } from './filesSource'

const shown = vi.hoisted(() => ({ items: [] as ContextMenuItem[] }))
vi.mock('@/components/ContextMenu', () => ({
  showContextMenu: (event: { stopPropagation(): void }, items: ContextMenuItem[]) => {
    event.stopPropagation()
    shown.items = items
  },
}))

const entry = (name: string, isDirectory = false): DirEntry => ({
  name,
  path: `/lane/${name}`,
  relativePath: name,
  isDirectory,
})
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
const noFeatures = Object.fromEntries(
  Object.keys(localFilesSource('/lane').features).map((key) => [key, false]),
) as unknown as FilesSource['features']
const laneSource = (writeRefusal: string | null = null): FilesSource => ({
  ...localFilesSource('/lane'),
  writeRefusal,
  features: noFeatures,
})
const labels = () => shown.items.map((item) => item.label)
const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`)
const render = async (source: FilesSource) => {
  await act(async () => root.render(<FileExplorer source={source} />))
}
const rowMenu = async () => {
  const row = container.querySelector('[data-path="/lane/a.ts"]')!
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  return labels()
}
const accepts = (type: string) => {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.assign(event, { dataTransfer: { types: [type], dropEffect: 'none' } })
  container.querySelector('[data-testid="file-explorer"]')!.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = () => {}
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'fs:readDir') return [entry('src', true), entry('a.ts')]
    if (channel === 'git:statusMap') return {}
    return undefined
  })
  Object.assign(window, { phosphor: { invoke } })
  useFilesStore.setState({ entries: {}, expanded: {}, byWorkspace: {}, listErrors: {} })
  shown.items = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('This Mac’s explorer offers search, list options, OS and clipboard actions', async () => {
  await render(localFilesSource('/lane'))
  expect(container.querySelector('button[aria-label^="Search in files"]')).not.toBeNull()
  expect(button('Show hidden files')).not.toBeNull()
  expect(await rowMenu()).toEqual([
    expect.stringMatching(/^(Reveal|Show|Open)/),
    'Copy path',
    'Copy relative path',
    'New file…',
    'New folder…',
    'Copy',
    'Cut',
    'Paste',
    'Import files…',
    'Import folders…',
    'Rename…',
    'Delete',
  ])
  expect(accepts('Files')).toBe(true)
})

it('a machine without those features keeps create, rename, delete and moves in the tree', async () => {
  await render(laneSource())
  expect(container.querySelector('button[aria-label^="Search in files"]')).toBeNull()
  expect(button('Show hidden files')).toBeNull()
  expect(button('Respect .gitignore')).toBeNull()
  expect(button('New file')).not.toBeNull()
  expect(container.textContent).toContain('Right-click for actions')
  expect(await rowMenu()).toEqual([
    'Copy relative path',
    'New file…',
    'New folder…',
    'Rename…',
    'Delete',
  ])
  expect(accepts('Files')).toBe(false)
  expect(accepts('application/x-phosphor-explorer')).toBe(true)
})

it('a lane this device cannot write is read only', async () => {
  await render(laneSource('Take control first.'))
  expect(container.textContent).toContain('Read only')
  expect(container.querySelector('[data-tooltip="Take control first."]')).not.toBeNull()
  expect(button('New file')).toBeNull()
  expect(await rowMenu()).toEqual(['Copy relative path'])
  expect(container.querySelector('[data-path="/lane/a.ts"]')?.getAttribute('draggable')).toBe(
    'false',
  )
  expect(accepts('application/x-phosphor-explorer')).toBe(false)
})

it('says why the list or git status could not be read', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'git:statusMap') throw new Error('not a repository')
    return []
  })
  await render(laneSource())
  await act(async () =>
    useFilesStore.setState({ listErrors: { '/lane': 'Could not read files.' } }),
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not read files.')
  expect(container.textContent).toContain('Git status is unavailable.')
  expect(container.textContent).not.toContain('Empty folder')
})

it('Refresh explorer reads the tree and its git status again', async () => {
  await render(laneSource())
  const reads = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel).length
  const before = { dirs: reads('fs:readDir'), git: reads('git:statusMap') }
  await act(async () => (button('Refresh explorer') as HTMLButtonElement).click())
  expect(reads('fs:readDir')).toBeGreaterThan(before.dirs)
  expect(reads('git:statusMap')).toBe(before.git + 1)
})
