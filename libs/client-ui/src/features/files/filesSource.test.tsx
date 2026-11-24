// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from '@/platform/Platform'
import { useHostFilesSource, localFilesSource, type FilesSource } from './filesSource'

afterEach(() => {
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

async function hostSource(
  platform: Platform = DESKTOP_PLATFORM,
): Promise<{ read: () => FilesSource; done: () => void }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let source: FilesSource | undefined
  function Probe(): null {
    source = useHostFilesSource(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <Probe />
      </PlatformProvider>,
    ),
  )
  return { read: () => source!, done: () => act(() => root.unmount()) }
}

function seed(self: boolean, capabilities: Parameters<typeof hostLaneSession>[0]['capabilities']) {
  const { hosts, live } = hostLaneSession({ self, capabilities })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
}

const update = (change: (host: NonNullable<ReturnType<typeof current>>) => object) =>
  act(async () =>
    useRemoteLanesStore.setState((s) => ({
      hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...current()!, ...change(current()!) } },
    })),
  )
const current = () => useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]

it('This Mac’s folder is a watched tree with every feature and no refusal', () => {
  expect(localFilesSource('/repo')).toEqual({
    workspacePath: '/repo',
    pathRoot: '/repo',
    unavailable: null,
    writeRefusal: null,
    listing: 'tree',
    refreshKey: '',
    textLimitBytes: 4 * 1024 * 1024,
    byteLimits: {
      download: 1024 * 1024 * 1024,
      tooLarge: 'Larger than 1 GB: too big to bring over from its Host.',
      preview: 1024 * 1024 * 1024,
    },
    features: {
      watch: true,
      search: true,
      mediaPreview: true,
      osActions: true,
      listOptions: true,
      clipboardFiles: true,
      revert: true,
      download: false,
      openDownloads: false,
      hostPreview: null,
    },
  })
})

it('a Host lane is a flat list without the local-only features', async () => {
  seed(true, ['workspaces.read', 'workspaces.write'])
  const source = await hostSource()
  expect(source.read()).toMatchObject({
    workspacePath: mockRemoteInfo.workspacePath,
    pathRoot: '/remote/demo',
    unavailable: null,
    writeRefusal: null,
    listing: 'flat',
    textLimitBytes: 2 * 1024 * 1024,
  })
  expect(Object.values(source.read().features).every((on) => !on)).toBe(true)
  source.done()
})

it('a Host serving file bytes offers downloads and previews, as each client can take them', async () => {
  seed(true, ['workspaces.read'])
  await update(() => ({ fileBytes: true }))
  const desktop = await hostSource()
  expect(desktop.read()).toMatchObject({
    sessionId: mockRemoteInfo.sessionId,
    byteLimits: { download: 1024 * 1024 * 1024, preview: 1024 * 1024 * 1024 },
  })
  expect(desktop.read().features).toMatchObject({
    download: true,
    openDownloads: true,
    hostPreview: 'stream',
  })
  desktop.done()
  // A browser holds each file in memory, so it takes less, and has no app to open it in.
  for (const platform of [COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM]) {
    const browser = await hostSource(platform)
    expect(browser.read().features).toMatchObject({
      download: true,
      openDownloads: false,
      hostPreview: 'blob',
    })
    expect(browser.read().byteLimits).toEqual({
      download: 100 * 1024 * 1024,
      tooLarge: 'Larger than 100 MB: too big to download in a browser.',
      preview: 50 * 1024 * 1024,
    })
    browser.done()
  }
  await update(() => ({ fileBytes: undefined }))
  for (const platform of [DESKTOP_PLATFORM, COMPACT_PLATFORM]) {
    const older = await hostSource(platform)
    expect(older.read().features).toMatchObject({ download: false, hostPreview: null })
    older.done()
  }
})

it('a Host lane says why it cannot be read or written', async () => {
  seed(false, [])
  const source = await hostSource()
  expect(source.read().unavailable).toBe('This Host does not offer files to this device.')
  expect(source.read().writeRefusal).not.toBeNull()
  source.done()
})

it('refreshes on the lane’s summary, the connection and the runtime, not on other updates', async () => {
  seed(true, ['workspaces.read'])
  const source = await hostSource()
  const keys = [source.read().refreshKey]
  await update((host) => ({ capabilities: [...host.capabilities] }))
  await update((host) => ({ lanes: [...host.lanes, { ...host.lanes[0]!, laneId: 'other' }] }))
  expect(source.read().refreshKey).toBe(keys[0])
  await update((host) => ({
    lanes: host.lanes.map((lane) => ({ ...lane, updatedAt: new Date(9).toISOString() })),
  }))
  keys.push(source.read().refreshKey)
  await update(() => ({ connectionToken: 'mock-connection-2' }))
  keys.push(source.read().refreshKey)
  await update(() => ({ cursor: { epoch: 'next', seq: 0 } }))
  keys.push(source.read().refreshKey)
  expect(new Set(keys).size).toBe(4)
  source.done()
})

it.each([
  [DESKTOP_PLATFORM, true],
  [WIDE_BROWSER_PLATFORM, false],
] as const)(
  'only a native client gets the local service lane’s same-machine file tools',
  async (platform, local) => {
    seed(true, ['workspaces.read', 'workspaces.write'])
    await update(() => ({ local: true, ownerLocal: true }))
    const source = await hostSource(platform)
    expect(source.read().features.search).toBe(local)
    expect(source.read().features.osActions).toBe(local)
    expect(source.read().workspacePath).toBe(mockRemoteInfo.workspacePath)
    source.done()
  },
)
