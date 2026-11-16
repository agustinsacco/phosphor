// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { ArtifactsPane } from './ArtifactsPane'
import { useArtifactsStore } from '@/stores/artifacts'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { useLayoutStore } from '@/stores/layout'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import {
  COMPACT_PLATFORM,
  WIDE_BROWSER_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'
import { ContextMenuHost } from '@/components/ContextMenu'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/files/MonacoEditor', () => ({ MonacoDiff: () => <div data-monaco-diff /> }))
vi.mock('@/components/markdown/MermaidBlock', () => ({ MermaidBlock: () => null }))
vi.mock('@/components/markdown/ChartBlock', () => ({ ChartBlock: () => null }))

let root: Root
let container: HTMLDivElement
let cleanup: () => void
const id = mockRemoteInfo.sessionId
const workspace = mockRemoteInfo.workspacePath
const revision = 'a'.repeat(64)
const write = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const fake = createFakePhosphor({
    'fs:readFile': () => ({ content: 'old', binary: false, size: 3, revision }),
    'fs:writeFile': write.mockResolvedValue({ mtimeMs: 1, revision }),
  })
  const restore = installFakePhosphor(fake)
  cleanup = () => {
    restore()
    fake.dispose()
  }
  useSessionsStore.setState({ live: { [id]: { ...mockRemoteInfo, phosphorId: id } } })
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...host,
        capabilities: [
          'workspaces.read',
          'workspaces.write',
          'sessions.read',
          'sessions.control',
          'artifacts.read',
        ],
        lanes: host.lanes.map((lane) => ({
          ...lane,
          control: {
            ...lane.control,
            controller: { self: true, connected: true, label: 'Browser' },
          },
        })),
      },
    },
  })
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
  for (const version of [1, 2])
    useArtifactsStore.getState().ingest(id, version === 1 ? 'artifact_create' : 'artifact_update', {
      id: 'guide',
      title: 'Guide',
      type: 'html',
      content: `<h1>Version ${version}</h1>`,
      version,
    })
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    }),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useRemoteLanesStore.setState({ hosts: {} })
  useFilesStore.setState({ byWorkspace: {} })
  write.mockClear()
})
async function render(platform: Platform) {
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <ArtifactsPane sessionId={id} workspacePath={workspace} />
        <ContextMenuHost />
      </PlatformProvider>,
    ),
  )
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) =>
      node.getAttribute('aria-label') === name ||
      node.textContent?.trim() === name ||
      node.getAttribute('data-tooltip') === name,
  )
async function secondary(name: string) {
  if (!button(name)) await act(async () => button('Artifact actions')?.click())
  return button(name)
}
for (const platform of [COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM]) {
  it(`${platform.formFactor}: browser Diff is available and PDF is absent`, async () => {
    await render(platform)
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="View"]')
    if (select)
      await act(async () => {
        select.value = 'diff'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    else {
      expect(button('Diff')).toBeDefined()
      await act(async () => button('Diff')!.click())
    }
    expect(
      container.querySelector(
        platform === COMPACT_PLATFORM ? '[aria-label="Unified diff"]' : '[data-monaco-diff]',
      ),
    ).not.toBeNull()
    expect(document.body.textContent).not.toContain('PDF')
    expect(document.querySelector('[aria-label*="PDF"]')).toBeNull()
  })
  it(`${platform.formFactor}: a controller writes the shown artifact into its Host Files`, async () => {
    await render(platform)
    const action = await secondary('Write into workspace and open in Files')
    expect(action).toBeDefined()
    expect(action?.disabled).toBe(false)
    await act(async () => action!.click())
    expect(write).toHaveBeenCalledWith(`${workspace}/guide.html`, '<h1>Version 2</h1>', revision)
    expect(workspaceFiles(useFilesStore.getState(), workspace).activePath).toBe(
      `${workspace}/guide.html`,
    )
    expect(useLayoutStore.getState().bySession[id]?.pane).toBe('files')
  })
  it.each(['Take control first.', 'This Host does not offer file editing to this device.'])(
    `${platform.formFactor}: Write in Files refuses with %s`,
    async (reason) => {
      const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
      useRemoteLanesStore.setState({
        hosts: {
          [MOCK_HOST_ID]: reason.startsWith('Take')
            ? {
                ...host,
                lanes: host.lanes.map((lane) => ({
                  ...lane,
                  control: { ...lane.control, controller: null },
                })),
              }
            : { ...host, capabilities: host.capabilities.filter((c) => c !== 'workspaces.write') },
        },
      })
      await render(platform)
      if (platform === COMPACT_PLATFORM) await act(async () => button('Artifact actions')?.click())
      const refused = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) =>
          node.getAttribute('data-tooltip') === reason || node.textContent?.includes(reason),
      )
      expect(refused?.disabled).toBe(true)
      expect(write).not.toHaveBeenCalled()
    },
  )
  it(`${platform.formFactor}: HTML downloads raw shown source as an octet stream, never a page`, async () => {
    await render(platform)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await act(async () => (await secondary('Download source'))!.click())
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    expect(blob.type).toBe('application/octet-stream')
    expect(
      await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsText(blob)
      }),
    ).toBe('<h1>Version 2</h1>')
    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('guide.html')
  })
}
