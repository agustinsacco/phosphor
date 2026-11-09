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
    features: {
      watch: true,
      search: true,
      mediaPreview: true,
      osActions: true,
      listOptions: true,
      clipboardFiles: true,
      revert: true,
      download: false,
      streamPreview: false,
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

it('a Host serving file bytes offers downloads through the lane, where files save natively', async () => {
  seed(true, ['workspaces.read'])
  await update(() => ({ fileBytes: true }))
  const desktop = await hostSource()
  expect(desktop.read()).toMatchObject({ sessionId: mockRemoteInfo.sessionId })
  expect(desktop.read().features).toMatchObject({ download: true, streamPreview: true })
  desktop.done()
  const browser = await hostSource(COMPACT_PLATFORM)
  expect(browser.read().features).toMatchObject({ download: false, streamPreview: false })
  browser.done()
  await update(() => ({ fileBytes: undefined }))
  const older = await hostSource()
  expect(older.read().features.download).toBe(false)
  older.done()
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
