// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_LIMITS } from '@shared/host-protocol-files'
import { useFilesStore, type OpenFile } from '@/stores/files'
import { EditorPane } from './EditorPane'
import { localFilesSource, type FilesSource } from './filesSource'

// The settings store reads the colour scheme when the viewer's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: () => {},
  MonacoEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <textarea data-testid="editor" value={value} readOnly={readOnly} onChange={() => {}} />
  ),
}))
vi.mock('./TextFileRender', () => ({
  default: ({ content }: { content: string }) => <div data-testid="rendered">{content}</div>,
}))

const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
const lane = (writeRefusal: string | null = null): FilesSource => ({
  ...localFilesSource('/lane'),
  writeRefusal,
  features: {
    watch: false,
    search: false,
    mediaPreview: false,
    osActions: false,
    listOptions: false,
    clipboardFiles: false,
    revert: false,
  },
})
const open = (file: Partial<OpenFile> & { path: string }) =>
  useFilesStore.setState({
    byWorkspace: {
      '/lane': {
        openFiles: [
          {
            instanceId: 1,
            relativePath: file.path.slice('/lane/'.length),
            language: 'plaintext',
            savedContent: 'text',
            content: 'text',
            mtimeMs: 1,
            size: 4,
            dirty: false,
            ...file,
          },
        ],
        activePath: file.path,
        gitStatus: {},
      },
    },
  })
const render = async (source: FilesSource) => {
  await act(async () => root.render(<EditorPane source={source} />))
}
const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent)

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = () => {}
  invoke.mockReset().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 2, revision: 'r2' })
  Object.assign(window, { phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('renders HTML from the buffer where the machine has no preview grant, without OS actions', async () => {
  open({ path: '/lane/page.html', content: '<p>edited</p>', dirty: true })
  await render(lane())
  expect(container.querySelector('[data-testid="rendered"]')?.textContent).toBe('<p>edited</p>')
  expect(container.textContent).not.toContain('the preview shows the saved file')
  expect(buttons()).not.toContain('Open')
  expect(buttons()).not.toContain('Reveal')
  expect(invoke).not.toHaveBeenCalledWith('fs:previewUrl', expect.anything(), expect.anything())
})

it('shows a binary file as a card without OS actions', async () => {
  open({ path: '/lane/photo.png', binary: true })
  await render(lane())
  expect(container.textContent).toContain('photo.png')
  expect(buttons()).not.toContain('Open in default app')
})

it('keeps the editor read only while the lane refuses writes', async () => {
  open({ path: '/lane/a.ts' })
  await render(lane('Take control first.'))
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')?.readOnly).toBe(
    true,
  )
  await render(lane())
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')?.readOnly).toBe(
    false,
  )
})

it('an uncertain save keeps the edits and offers only a reload', async () => {
  open({ path: '/lane/a.ts', content: 'edited', dirty: true, revision: 'r1', saveUncertain: true })
  await render(lane())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Do not retry an uncertain save',
  )
  const reload = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Reload file',
  )
  await act(async () => reload?.click())
  expect(invoke).toHaveBeenCalledWith('fs:readFile', '/lane/a.ts')
  expect(useFilesStore.getState().byWorkspace['/lane']?.openFiles[0]).toMatchObject({
    content: 'disk',
    revision: 'r2',
    saveUncertain: false,
  })
})

it('offers Keep mine on a conflict only where a save does not check the revision', async () => {
  open({ path: '/lane/a.ts', content: 'edited', dirty: true, diskConflict: true, revision: 'r1' })
  await render(lane())
  expect(buttons()).toContain('Reload')
  expect(buttons()).not.toContain('Keep mine')
  open({ path: '/lane/a.ts', content: 'edited', dirty: true, diskConflict: true })
  await render(localFilesSource('/lane'))
  expect(buttons()).toContain('Keep mine')
})

it('names the finder shortcut only where the machine searches', async () => {
  await render(lane())
  expect(container.textContent).toContain('Pick a file from the explorer')
  expect(container.textContent).not.toContain('or press')
  await render(localFilesSource('/lane'))
  expect(container.textContent).toContain('or press')
})

it('This Mac says an oversized file is larger than its 4 MB read limit', async () => {
  open({ path: '/lane/big.txt', tooLarge: true, size: 5 * 1024 * 1024 })
  await render(localFilesSource('/lane'))
  expect(container.textContent).toContain('5.0 MB · Larger than 4 MB — too big to open as text.')
})

it('a Host names its own read limit, without a size it did not send', async () => {
  open({ path: '/lane/big.txt', tooLarge: true, size: 0 })
  await render({ ...lane(), textLimitBytes: FILE_LIMITS.textBytes })
  expect(container.textContent).toContain('Larger than 2 MB — too big to open as text.')
  expect(container.textContent).not.toContain('0 B')
})
