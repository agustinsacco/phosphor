// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, MIN_PI_VERSION } from '@shared/models'
import type { MachineSettings } from '@shared/machine-settings'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
let hostRead: (hostId: string, section: string) => MachineSettings = (hostId, section) =>
  mockSettingsRead(hostId, section as never)
const invoke = vi.fn(async (channel: string, hostId?: string, section?: string) => {
  if (channel === 'hosts:settingsRead') return hostRead(hostId!, section!)
  if (channel === 'pi:health')
    return {
      ok: true,
      version: '0.9.0',
      minVersion: '0.8.0',
      binaryPath: '/opt/homebrew/bin/pi',
      path: ['/opt/homebrew/bin', '/usr/bin'],
      agentDir: '/Users/me/.pi/agent',
    }
  if (channel === 'pi:listResources') return { extensions: [], prompts: [], themes: [] }
  if (channel === 'app:getPrefs') return DEFAULT_APP_PREFS
  if (channel === 'maintenance:scan') return []
  if (channel === 'app:about')
    return { appVersion: '9.8.7', platform: 'darwin', arch: 'arm64', electron: '1', node: '1' }
  if (channel === 'updates:state') return { phase: 'idle' }
  return undefined
})
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onUpdateEvent: () => () => {} })
  useRemoteLanesStore.setState({ filter: 'local', hosts: mixedRemoteHosts() })
  prepareHostSettings(machine)
  hostRead = (hostId, section) => mockSettingsRead(hostId, section as never)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('shows This Mac the PATH pi runs with and its agent directory (D4)', async () => {
  await showHostSettings(root, 'local', 'advanced')
  const text = container.textContent ?? ''
  expect(text).toContain('/opt/homebrew/bin/pi — minimum supported 0.8.0')
  expect(text).toContain('Executable search path')
  expect(text).toContain('/opt/homebrew/bin')
  expect(text).toContain('/Users/me/.pi/agent')
  expect(text).not.toContain('Pause and update')
})

it("shows a Host's pi beside its update, and asks an older Host to update (P77)", async () => {
  await showHostSettings(root, machine.id, 'advanced')
  expect(container.textContent).toContain('v1.2.0')
  expect(container.textContent).toContain('pi-coding-agent/dist/cli.js')
  act(() => root.unmount())
  root = createRoot(container)
  hostRead = (hostId, section) => {
    const read = mockSettingsRead(hostId, section as never)
    delete read.advanced?.pi
    return read
  }
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  await showHostSettings(root, machine.id, 'advanced')
  expect(container.textContent).toContain('Update this Host to see its pi')
  expect(container.textContent).not.toContain('pi health')
  expect(container.textContent).toContain('/home/bee1/.pi/agent')
})

it("holds a Host's pi to the minimum This Mac's is held to (B19)", async () => {
  hostRead = (hostId, section) => {
    const read = mockSettingsRead(hostId, section as never)
    if (read.advanced?.pi) read.advanced.pi.version = '1.1.9'
    return read
  }
  await showHostSettings(root, machine.id, 'advanced')
  const text = container.textContent ?? ''
  expect(text).toContain(`dist/cli.js — minimum supported ${MIN_PI_VERSION}`)
  expect(text).toContain('too-old')
  expect(text).not.toContain('v1.1.9')
})

it("passes a Host's prerelease pi at the minimum, as the Host's own gate does (settings F1)", async () => {
  hostRead = (hostId, section) => {
    const read = mockSettingsRead(hostId, section as never)
    if (read.advanced?.pi) read.advanced.pi.version = `${MIN_PI_VERSION}-rc.1`
    return read
  }
  await showHostSettings(root, machine.id, 'advanced')
  const text = container.textContent ?? ''
  expect(text).toContain(`v${MIN_PI_VERSION}-rc.1`)
  expect(text).not.toContain('too-old')
})

it("shows This Mac's own version and update where a Host shows its own (B23)", async () => {
  await showHostSettings(root, 'local', 'advanced')
  await act(async () => {})
  const text = container.textContent ?? ''
  expect(text).toContain('Phosphor version')
  expect(text).toContain('9.8.7')
  const check = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Check now',
  )
  expect(check).toBeDefined()
  await act(async () => check!.click())
  expect(invoke).toHaveBeenCalledWith('updates:check')
})

it('names the platform the same way on This Mac and on a Host', async () => {
  await showHostSettings(root, 'local', 'advanced')
  await act(async () => {})
  expect(container.textContent).toContain('macOS')
  expect(container.textContent).not.toContain('darwin')
  act(() => root.unmount())
  root = createRoot(container)
  await showHostSettings(root, machine.id, 'advanced')
  expect(container.textContent).toContain('Linux')
})

/** Runs `run` while `channel` rejects, then answers it again. */
async function withFailing(channel: string, run: () => Promise<void>): Promise<void> {
  const answer = invoke.getMockImplementation()!
  invoke.mockImplementation(async (name: string, hostId?: string, section?: string) => {
    if (name === channel) throw new Error(`no ${channel}`)
    return answer(name, hostId, section)
  })
  try {
    await run()
  } finally {
    invoke.mockImplementation(answer)
  }
}

it("keeps This Mac's update row when its version cannot be read", () =>
  withFailing('app:about', async () => {
    await showHostSettings(root, 'local', 'advanced')
    await act(async () => {})
    const text = container.textContent ?? ''
    expect(text).toContain('Phosphor updates')
    expect(text).toContain('Phosphor version')
    expect(text).toContain('unknown')
  }))

it('says in About that the version is unknown when the app cannot report it', () =>
  withFailing('app:about', async () => {
    await showHostSettings(root, 'local', 'about')
    await act(async () => {})
    expect(container.textContent).toMatch(/Phosphor version\s*unknown/)
  }))
