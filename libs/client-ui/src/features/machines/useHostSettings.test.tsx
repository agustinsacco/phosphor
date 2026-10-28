// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { DESKTOP_PLATFORM, PlatformProvider, type Platform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsSection,
} from '@shared/machine-settings'
import { useHostSettings, type HostSettingsState } from './useHostSettings'

let root: Root, container: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let state: HostSettingsState
const read =
  vi.fn<
    (
      hostId: string,
      section: MachineSettingsSection,
      repositoryId?: string,
    ) => Promise<MachineSettings>
  >()
const check = vi.fn<(hostId: string, repositoryId?: string) => Promise<MachineSettings>>()
const patch = vi.fn<(hostId: string, input: MachineSettingsPatch) => Promise<MachineSettings>>()
function sample(revision: string): MachineSettings {
  return { section: 'connectors', revision }
}
function Probe({ repositoryId }: { repositoryId?: string }) {
  state = useHostSettings('host', 'connectors', repositoryId)
  return null
}
const UNSUPPORTED: Platform = { ...DESKTOP_PLATFORM, machineSettings: false }
async function render(repositoryId?: string, supported = true) {
  await act(async () => {
    root.render(
      <PlatformProvider value={supported ? DESKTOP_PLATFORM : UNSUPPORTED}>
        <Probe repositoryId={repositoryId} />
      </PlatformProvider>,
    )
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({
    hosts: {
      host: {
        state: 'ready',
        capabilities: ['machine.configure'],
        configurationSupported: true,
        repositories: [],
        lanes: [],
        connectionToken: 'settings-test',
      },
    },
  })
  read.mockReset().mockResolvedValue(sample('initial'))
  check.mockReset().mockResolvedValue(sample('checked'))
  patch.mockReset().mockResolvedValue(sample('saved'))
  fake = createFakePhosphor({
    'hosts:settingsRead': read,
    'hosts:settingsCheck': check,
    'hosts:settingsPatch': patch,
  })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
it('does not read or check settings on unsupported clients, including support changes', async () => {
  await render(undefined, false)
  expect(state.supported).toBe(false)
  expect(state.allowed).toBe(false)
  await act(async () => {
    await state.refresh()
    await state.check()
  })
  expect(read).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
  await render()
  expect(state.data?.revision).toBe('initial')
  const oldRefresh = state.refresh
  await render(undefined, false)
  expect(state.data).toBeNull()
  await act(async () => {
    await oldRefresh()
  })
  expect(read).toHaveBeenCalledTimes(1)
})
it('ignores reads and checks completed after a folder scope change', async () => {
  let finishRead!: (value: MachineSettings) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve
      }),
  )
  await render('folder-a')
  await render('folder-b')
  expect(read).toHaveBeenLastCalledWith('host', 'connectors', 'folder-b')
  await act(async () => {
    finishRead(sample('old-folder'))
  })
  expect(state.data?.revision).toBe('initial')
  let finishCheck!: (value: MachineSettings) => void
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCheck = resolve
      }),
  )
  let checking!: Promise<void>
  act(() => {
    checking = state.check()
  })
  await render('folder-c')
  await act(async () => {
    finishCheck(sample('old-check'))
    await checking
  })
  expect(state.data?.revision).toBe('initial')
  expect(state.loading).toBe(false)
})
it('keeps the latest read when refreshes complete in reverse order', async () => {
  await render()
  let finishOld!: (value: MachineSettings) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve
      }),
  )
  let oldRead!: Promise<void>
  act(() => {
    oldRead = state.refresh()
  })
  read.mockResolvedValueOnce(sample('latest'))
  await act(async () => {
    await state.refresh()
  })
  await act(async () => {
    finishOld(sample('superseded'))
    await oldRead
  })
  expect(state.data?.revision).toBe('latest')
})
it('rejects stale mutation completions and callbacks after a connection generation changes', async () => {
  await render()
  const oldChange = state.change
  let finishPatch!: (value: MachineSettings) => void
  patch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPatch = resolve
      }),
  )
  let saving!: Promise<MachineSettings | null>
  act(() => {
    saving = state.change({ type: 'mcp.remove', name: 'github' })
  })
  await act(async () => {
    const host = useRemoteLanesStore.getState().hosts.host!
    useRemoteLanesStore.setState({
      hosts: { host: { ...host, connectionToken: 'new-generation' } },
    })
  })
  await act(async () => {
    finishPatch(sample('old-save'))
    expect(await saving).toBeNull()
  })
  await act(async () => {
    expect(await oldChange({ type: 'mcp.remove', name: 'github' })).toBeNull()
  })
  expect(state.data?.revision).toBe('initial')
  expect(state.saving).toBe(false)
  expect(patch).toHaveBeenCalledTimes(1)
})
