// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BROWSER_FILE_BYTES, FILE_BYTES_ERRORS } from '@shared/host-protocol-file-bytes'
import { useFilesStore, type OpenFile } from '@/stores/files'
import { EditorPane } from './EditorPane'
import { localFilesSource, type FilesSource } from './filesSource'

// A browser previews a Host lane's images and media from their bytes, read whole into a Blob.

vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: () => {}, MonacoEditor: () => null }))

const invoke = vi.fn()
const revoke = vi.fn()
let root: Root
let container: HTMLDivElement
const MB = 1024 * 1024

/** A browser's view of a Host lane whose Host serves file bytes. */
const browserLane = (): FilesSource => {
  const local = localFilesSource('/lane')
  return {
    ...local,
    sessionId: 'remote-1',
    byteLimits: {
      download: BROWSER_FILE_BYTES.downloadBytes,
      tooLarge: FILE_BYTES_ERRORS.browserTooLarge,
      preview: BROWSER_FILE_BYTES.previewBytes,
    },
    features: {
      ...(Object.fromEntries(
        Object.keys(local.features).map((key) => [key, false]),
      ) as unknown as FilesSource['features']),
      download: true,
      hostPreview: 'blob',
    },
  }
}
const open = (path: string, size: number) =>
  useFilesStore.setState({
    byWorkspace: {
      '/lane': {
        openFiles: [
          {
            instanceId: 1,
            path,
            relativePath: path.slice('/lane/'.length),
            language: 'plaintext',
            savedContent: '',
            content: '',
            mtimeMs: 0,
            size,
            dirty: false,
            binary: true,
          } as OpenFile,
        ],
        activePath: path,
        gitStatus: {},
      },
    },
  })
const render = async () => {
  await act(async () => root.render(<EditorPane source={browserLane()} />))
}
const buttons = () => [...container.querySelectorAll('button')]
const labels = () => buttons().map((b) => b.textContent)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = () => {}
  invoke.mockReset()
  revoke.mockReset()
  vi.stubGlobal('phosphor', { invoke })
  URL.revokeObjectURL = revoke
  useFilesStore.setState({ byWorkspace: {} })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('shows an image from its blob URL as it came, and revokes it on close', async () => {
  invoke.mockResolvedValue('blob:https://app/one')
  open('/lane/art/logo.png', 2 * MB)
  await render()
  expect(invoke).toHaveBeenCalledWith('hosts:filePreviewUrl', {
    sessionId: 'remote-1',
    path: 'art/logo.png',
  })
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:https://app/one')
  expect(container.querySelector('iframe')).toBeNull()
  expect(labels()).toContain('Download')
  expect(labels()).not.toContain('Open in default app')
  expect(revoke).not.toHaveBeenCalled()
  act(() => root.unmount())
  expect(revoke).toHaveBeenCalledWith('blob:https://app/one')
  root = createRoot(container)
})

it('plays video and audio from their blobs', async () => {
  invoke.mockResolvedValue('blob:https://app/clip')
  open('/lane/clip.mp4', MB)
  await render()
  expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:https://app/clip')
  open('/lane/sound.mp3', MB)
  await render()
  expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:https://app/clip')
})

it('revokes a blob that arrives after the viewer closed', async () => {
  let resolve: (url: string) => void = () => {}
  invoke.mockReturnValue(new Promise<string>((r) => (resolve = r)))
  open('/lane/art/logo.png', MB)
  await render()
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () => resolve('blob:https://app/late'))
  expect(revoke).toHaveBeenCalledWith('blob:https://app/late')
})

it('refuses any URL but a blob for a browser preview', async () => {
  invoke.mockResolvedValue('https://elsewhere.example/logo.png')
  open('/lane/art/logo.png', MB)
  await render()
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).toContain('This file could not be shown here.')
})

it('never embeds a PDF in a browser: it offers Download instead', async () => {
  open('/lane/docs/spec.pdf', MB)
  await render()
  expect(invoke).not.toHaveBeenCalled()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.textContent).toContain('No preview for .pdf files.')
  expect(labels().filter((label) => label === 'Download').length).toBeGreaterThan(0)
})

it('a file over the preview cap is not read: it offers Download instead', async () => {
  open('/lane/clip.mp4', BROWSER_FILE_BYTES.previewBytes + 1)
  await render()
  expect(invoke).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Larger than 50 MB: too big to preview in a browser.')
  expect(labels()).toContain('Download')
})

it('a file over the download cap is refused up front, with the reason', async () => {
  open('/lane/huge.bin', BROWSER_FILE_BYTES.downloadBytes + 1)
  await render()
  const download = buttons().find((b) => b.textContent === 'Download')!
  expect(download.disabled).toBe(true)
  expect(download.dataset.tooltip).toBe(FILE_BYTES_ERRORS.browserTooLarge)
})
