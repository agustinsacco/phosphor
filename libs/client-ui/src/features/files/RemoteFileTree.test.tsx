// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFileTree } from './RemoteFileTree'
import { useTreeFolders, type TreeFolders } from './useTreeFolders'
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
it('shows loading, empty and bounded tree refusal rather than raw toolbar text or partial trees', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'),
    root = createRoot(container)
  const render = (files: string[], loading = false, selected: string | null = null) =>
    act(() =>
      root.render(
        <RemoteFileTree files={files} selected={selected} onSelect={() => {}} loading={loading} />,
      ),
    )
  try {
    render([], true)
    expect(container.textContent).toContain('Loading')
    render([])
    expect(container.textContent).toBe('No files yet')
    const deep = Array(64).fill('a').join('/')
    render([deep])
    expect(container.querySelectorAll('[role=treeitem]')).toHaveLength(1)
    render([deep], false, deep)
    expect(container.querySelectorAll('[role=treeitem]')).toHaveLength(64)
    render([Array(65).fill('a').join('/')])
    expect(container.textContent).toContain('Not available')
    expect(container.querySelector('[role=tree]')).toBeNull()
    render(Array.from({ length: 17000 }, (_v, i) => `dir${i}/sub/file`))
    expect(container.querySelector('[role=tree]')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})

function mount(node: () => React.JSX.Element) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'),
    root = createRoot(container)
  const render = () => act(() => root.render(node()))
  render()
  const rows = () =>
    [...container.querySelectorAll('[role=treeitem]')].map(
      (row) => `${row.getAttribute('aria-expanded') ?? '-'} ${row.textContent ?? ''}`,
    )
  const click = (name: string) => {
    const row = [...container.querySelectorAll<HTMLElement>('[role=treeitem]')].find(
      (r) => r.textContent === name,
    )
    act(() => row?.click())
  }
  return { render, rows, click, unmount: () => act(() => root.unmount()) }
}

const FILES = ['src/lib/a.ts', 'src/b.ts', 'README.md']

it('starts collapsed, opens a folder on click and closes it again', () => {
  const t = mount(() => <RemoteFileTree files={FILES} selected={null} onSelect={() => {}} />)
  try {
    expect(t.rows()).toEqual(['false src', '- README.md'])
    t.click('src')
    expect(t.rows()).toEqual(['true src', 'false lib', '- b.ts', '- README.md'])
    t.click('src')
    expect(t.rows()).toEqual(['false src', '- README.md'])
  } finally {
    t.unmount()
  }
})

it('opens the folders of a file selected from outside the tree', () => {
  let selected: string | null = null
  const t = mount(() => <RemoteFileTree files={FILES} selected={selected} onSelect={() => {}} />)
  try {
    selected = 'src/lib/a.ts'
    t.render()
    expect(t.rows()).toEqual(['true src', 'true lib', '- a.ts', '- b.ts', '- README.md'])
    // Closing a folder of the selection sticks until the selection changes.
    t.click('lib')
    expect(t.rows()).toEqual(['true src', 'false lib', '- b.ts', '- README.md'])
  } finally {
    t.unmount()
  }
})

it('opens the changes view expanded, and collapse all closes every folder', () => {
  let folders: TreeFolders | undefined
  function Pane() {
    folders = useTreeFolders(null, true)
    return <RemoteFileTree files={FILES} selected={null} onSelect={() => {}} folders={folders} />
  }
  const t = mount(() => <Pane />)
  try {
    expect(t.rows()).toEqual(['true src', 'true lib', '- a.ts', '- b.ts', '- README.md'])
    act(() => folders?.collapseAll())
    expect(t.rows()).toEqual(['false src', '- README.md'])
  } finally {
    t.unmount()
  }
})
