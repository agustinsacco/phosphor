// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
import type { LocalMachineStatus, HostConnectionView } from '@shared/ipc'
import type { ServicePauseState } from '@shared/host-protocol-owner'
import { COMPACT_PLATFORM } from '@/platform/Platform'
import { watchMachineUpdates } from '@/features/updates/watchMachineUpdates'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
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

/* Host Advanced, as the shared Settings renders it for a Host. */
const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root, container: HTMLDivElement
let status: LocalMachineStatus
let pause: ServicePauseState
let pauseControl: boolean
let job: { state: string; result: unknown }
let changed: ((next: LocalMachineStatus) => void) | undefined
let detach: (() => void) | undefined
let ptyExit: ((code: number) => void) | undefined
const ok = (data: unknown) => ({ status: 'ok', applies: 'now', text: 'Raw operation text', data })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onUpdateEvent: () => () => {},
    onPtyData: () => () => {},
    onPtyExit: (_id: string, callback: typeof ptyExit) => {
      ptyExit = callback
      return () => {}
    },
    onLocalMachineChanged: (callback: typeof changed) => {
      changed = callback
      return () => {}
    },
  })
  pause = { kind: 'none' }
  job = { state: 'running', result: null }
  pauseControl = true
  status = { mode: 'daemon', migration: 'committed', service: 'ready', serviceVersion: '1.0.0' }
  const hosts = mixedRemoteHosts()
  hosts[machine.id] = {
    ...hosts[machine.id]!,
    hostVersion: '1.0.0',
    cursor: { epoch: 'first', seq: 0 },
  }
  useRemoteLanesStore.setState({ hosts })
  prepareHostSettings(machine)
  invoke.mockReset().mockImplementation(async (channel, hostId, section) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section)
    if (channel === 'hosts:machineTask') return { ptyId: 'update' }
    if (channel === 'pty:attach') return { scrollback: 'already up to date\r\n' }
    if (channel === 'app:localMachine') return { ...status, pause }
    if (channel === 'app:localMachineAction' || section?.op === 'service.pause') {
      pause = { kind: 'none' }
      job = {
        state: 'done',
        result: { text: 'cancelled', data: { outcome: 'not-paused', pause: 'cancelled' } },
      }
      return { ...ok(undefined), ok: true }
    }
    if (section?.op === 'machine.status')
      return ok({ pause, update: pauseControl ? { pauseControl: true } : undefined })
    if (section?.op === 'service.update') return ok({ jobId: 'service-update' })
    if (section?.op === 'job.status') return ok({ op: 'service.update', ...job })
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  detach?.()
  detach = changed = ptyExit = undefined
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function button(label = 'Update…'): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`Missing ${label}`)
  return found
}
const click = async (label?: string) => act(async () => button(label).click())
const tick = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
function connection(patch: Partial<HostConnectionView>) {
  const hosts = useRemoteLanesStore.getState().hosts
  useRemoteLanesStore.setState({
    hosts: { ...hosts, [machine.id]: { ...hosts[machine.id]!, ...patch } },
  })
}
function startWatch(owner: boolean) {
  detach = watchMachineUpdates(owner)
}
const text = () => container.querySelector('section[aria-label="Software"]')?.textContent
const step = () => container.querySelector('[aria-current=step]')?.textContent

it('asks once before the legacy fixed-purpose task and shows no terminal', async () => {
  startWatch(true)
  await showHostSettings(root, machine.id, 'advanced')
  expect(text()).toContain('Phosphor Host 1.0.0 · Linux')
  await click()
  expect(vi.mocked(promptChoice).mock.calls[0]?.[0].message).toContain('This older Host can’t wait')
  expect(invoke).not.toHaveBeenCalledWith('hosts:machineTask', machine.id, expect.anything())
  vi.mocked(promptChoice).mockResolvedValue('update')
  await click()
  expect(invoke).toHaveBeenCalledWith('hosts:machineTask', machine.id, {
    type: 'machine.task',
    task: 'host.update',
  })
  expect(container.querySelector('[role=dialog]')).toBeNull()
  expect(step()).toBe('Download and verify')
  expect(text()).not.toContain('Wait for working lanes')
  await act(async () => ptyExit?.(0))
  await tick(800)
  expect(text()).toContain('Already up to date.')
  expect(container.querySelector('details')?.open).toBe(false)
})

it('offers no update while a private Host program cannot run', async () => {
  const hosts = mixedRemoteHosts()
  hosts[machine.id]!.capabilities = hosts[machine.id]!.capabilities.filter((c) => c !== 'terminal')
  useRemoteLanesStore.setState({ hosts })
  await showHostSettings(root, machine.id, 'advanced')
  expect(button().disabled).toBe(true)
})

it("shows the Host's paths, PATH and environment names, never values or raw editors", async () => {
  await showHostSettings(root, machine.id, 'advanced')
  const text = container.textContent ?? ''
  expect(text).toContain('/home/bee1/.config/phosphor/host.json')
  expect(text).toContain('/home/bee1/.pi/agent')
  expect(text).toContain('/usr/bin')
  expect(text).toContain('EXAMPLE_API_KEY')
  expect(text).toContain('Missing from service')
  expect(text).not.toContain('settings.json')
  expect(text).not.toContain('Edit…')
})

const waiting: ServicePauseState = {
  kind: 'pausing',
  purpose: 'update',
  since: 'now',
  deadline: '2099-01-01T14:32:00Z',
  waitingOn: { turns: 2, subagents: 1, routines: 0 },
}

it.each([
  ['Desktop service', true],
  ['PWA Host', false],
] as const)(
  '%s keeps a stable wait and shows Cancel as a neutral ending after leaving Settings',
  async (_surface, owner) => {
    connection({ ops: true, ...(owner ? { local: true } : {}) })
    startWatch(owner)
    const platform = owner ? undefined : COMPACT_PLATFORM
    await showHostSettings(root, machine.id, 'advanced', platform)
    expect(text()).toContain(owner ? 'Phosphor service 1.0.0' : 'Phosphor Host 1.0.0 · Linux')
    vi.mocked(promptChoice).mockResolvedValue('update')
    await click()
    expect(step()).toBe('Download and verify')
    expect(container.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
    expect(vi.mocked(promptChoice)).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'ops:run',
      { kind: 'remote', hostId: machine.id },
      { op: 'service.update', args: {} },
    )
    await act(async () => root.render(null))
    pause = waiting
    await tick(2200)
    await showHostSettings(root, machine.id, 'advanced', platform)
    expect(step()).toBe('Wait for working lanes')
    expect(text()).toContain('Waiting for 2 turns')
    pause = { ...waiting, waitingOn: { ...waiting.waitingOn, turns: 1 } }
    await tick(2000)
    expect(text()).toContain('Waiting for 1 turn')
    await click('Cancel update')
    expect(text()).not.toContain("didn't finish")
    await tick(800)
    expect(text()).toContain('Update cancelled. Nothing changed.')
    expect(container.querySelector('details')?.open).toBe(false)
  },
)

it('keeps Advanced mounted when the local slot clears its pause and flaps between ready and down', async () => {
  connection({ local: true, ops: true })
  pause = { kind: 'paused', purpose: 'update', since: 'now' }
  // Let the initial settings read land before the pause is observed.
  await showHostSettings(root, machine.id, 'advanced')
  expect(container.textContent).toContain('/usr/bin')
  await act(async () => startWatch(true))
  invoke.mockClear()
  await act(async () => {
    changed?.({ ...status, service: 'down', pause: undefined })
    connection({ state: 'reconnecting' })
  })
  await tick(1600)
  expect(step()).toBe('Restart')
  await act(async () => connection({ state: 'ready', connectionToken: 'flap' }))
  await act(async () => connection({ state: 'reconnecting' }))
  await tick(3000)
  expect(step()).toBe('Restart')
  expect(container.textContent).toContain('/usr/bin')
  expect(container.textContent).not.toContain('Start service')
  expect(container.textContent).not.toContain('service unavailable')
  expect(invoke).not.toHaveBeenCalledWith(
    'hosts:settingsRead',
    machine.id,
    expect.anything(),
    undefined,
  )
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'hosts:reconnect').length,
  ).toBeGreaterThanOrEqual(2)
  pause = { kind: 'none' }
  await act(async () =>
    connection({ state: 'ready', hostVersion: '1.1.0', cursor: { epoch: 'second', seq: 0 } }),
  )
  await tick(1500)
  expect(text()).toContain('Updated to 1.1.0')
})

it('gives a deadline instead of Stop or Cancel on an older ops Host', async () => {
  connection({ ops: true })
  pauseControl = false
  pause = waiting
  startWatch(false)
  await showHostSettings(root, machine.id, 'advanced', COMPACT_PLATFORM)
  await tick(800)
  expect(step()).toBe('Wait for working lanes')
  expect(text()).toMatch(/It gives up at .+ and changes nothing/)
  expect(text()).not.toMatch(/Stop turns|Cancel update/)
})
