import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LocalMachineAction, LocalMachineStatus } from '@shared/ipc'
import { bindSameMachine } from '../local-machine/same-machine'
import {
  bindLocalMachineGate,
  notifyLocalMachineChanged,
  registerLocalMachineHandlers,
} from './local-machine-handlers'
import { bindOpsHosts } from './ops-handlers'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  push: vi.fn(),
  start: vi.fn(),
  diagnostics: vi.fn(),
  restart: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => h.handlers.set(name, cb),
}))
vi.mock('../broadcast', () => ({ broadcast: h.push }))
vi.mock('./local-service-actions', () => ({
  startService: h.start,
  exportServiceDiagnostics: h.diagnostics,
  restartToFinish: h.restart,
}))
const invoke = (name: string, ...args: unknown[]) => h.handlers.get(name)!(null, ...args)
const get = () => invoke('app:localMachine')
const act = (name: LocalMachineAction) => invoke('app:localMachineAction', name)
let status: LocalMachineStatus
let cb: (() => void) | undefined
const retry = vi.fn(),
  consent = vi.fn(),
  off = vi.fn()
const machine = 'mac'
const none = { kind: 'none' }
const pausing = {
  kind: 'pausing',
  purpose: 'update',
  since: 'now',
  deadline: 'later',
  waitingOn: { turns: 2, routines: 0, subagents: 1 },
}
function slot() {
  const snap = {
    state: 'ready',
    hostVersion: '1.2.3',
    connectionToken: 'one',
    repositories: [],
    lanes: [],
    capabilities: [],
  } as const
  const call = vi.fn(async (_method: string, _params: unknown) => ({
    ok: true as const,
    data: { machineId: machine, hostVersion: '1.2.3', pause: none },
  }))
  const c = {
    snapshot: () => ({ ...snap, lanes: [], repositories: [], capabilities: [] }),
    call,
    send: vi.fn(async () => ({
      status: 'done' as const,
      data: { status: 'ok', text: 'Started: update', applies: 'now' },
    })),
  }
  bindSameMachine({ hostId: machine, connection: () => c })
  bindOpsHosts((id) => (id === machine ? c : undefined))
  return c
}
beforeEach(() => {
  vi.clearAllMocks()
  status = { mode: 'daemon', migration: 'committed' }
  cb = undefined
  registerLocalMachineHandlers()
  bindLocalMachineGate({
    status: () => status,
    retry,
    consent,
    onStatus(listener) {
      cb = () => listener(status)
      return off
    },
  })
})
afterEach(() => {
  bindLocalMachineGate(null)
  bindSameMachine(null)
  bindOpsHosts(null)
})

it('pushes gate and local slot transitions without polling; duplicate lane notifications do not push', async () => {
  notifyLocalMachineChanged()
  notifyLocalMachineChanged()
  expect(h.push).toHaveBeenCalledTimes(1)
  expect(h.push).toHaveBeenLastCalledWith(
    'app:localMachineChanged',
    expect.objectContaining({ service: 'down' }),
  )
  const c = slot()
  notifyLocalMachineChanged()
  notifyLocalMachineChanged()
  expect(c.call).not.toHaveBeenCalled()
  expect(h.push).toHaveBeenCalledTimes(2)
  await expect(Promise.all([get(), get()])).resolves.toEqual(
    Array(2).fill({ ...status, service: 'ready', pause: none, serviceVersion: '1.2.3' }),
  )
  expect(c.call.mock.calls).toEqual([['machine.local', undefined]])
  status = { mode: 'in-app', migration: 'failed' }
  cb?.()
  expect(h.push).toHaveBeenLastCalledWith('app:localMachineChanged', status)
  bindLocalMachineGate(null)
  expect(off).toHaveBeenCalledOnce()
  expect(get()).toEqual({ mode: 'in-app', migration: 'not-needed' })
})
it('routes update only over the local service write receipt; before Abort now and Cancel rechecks the live pause', async () => {
  const c = slot()
  expect(await act('update-service')).toEqual({ ok: true, message: 'Started: update' })
  expect(c.send.mock.calls).toEqual([[{ type: 'ops.run', op: 'service.update', args: {} }]])
  expect(await act('update-abort-now')).toMatchObject({ ok: false })
  for (const [name, action] of [
    ['update-abort-now', 'abort-now'],
    ['update-cancel', 'cancel'],
  ] as const) {
    c.call.mockResolvedValueOnce({
      ok: true,
      data: { machineId: machine, hostVersion: '1.2.3', pause: pausing },
    })
    expect(await act(name)).toEqual({ ok: true })
    expect(c.call).toHaveBeenLastCalledWith('machine.pause', { action })
  }
  await act('start-service')
  expect(h.start).not.toHaveBeenCalled()
  bindSameMachine(null)
  await act('start-service')
  expect(h.start).toHaveBeenCalledOnce()
})
it('only delegates the migration actions legal at the time of the click', async () => {
  status = { mode: 'in-app', migration: 'consent-needed' }
  await act('consent-migration')
  await act('retry-migration')
  await act('restart-to-finish')
  expect(consent).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
  expect(h.restart).not.toHaveBeenCalled()
  status = { mode: 'in-app', migration: 'failed' }
  await act('retry-migration')
  await act('export-diagnostics')
  expect(retry).toHaveBeenCalledOnce()
  expect(h.diagnostics).toHaveBeenCalledWith(status)
  status = { mode: 'in-app', migration: 'committed' }
  await act('restart-to-finish')
  expect(h.restart).toHaveBeenCalledOnce()
})
