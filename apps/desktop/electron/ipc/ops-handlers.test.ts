import { beforeEach, expect, it, vi } from 'vitest'
import type * as OpsHandlers from './ops-handlers'

const state = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue({ status: 'ok', text: 'local' }),
  mode: 'in-app' as 'in-app' | 'daemon',
  service: undefined as { hostId: string } | undefined,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../ops/service', () => ({ desktopOps: () => ({ run: state.run }) }))
vi.mock('../local-machine/mode', () => ({ localRuntimeMode: () => state.mode }))
vi.mock('../local-machine/same-machine', () => ({ sameMachine: () => state.service }))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error('missing handler')
  return handler({ sender: { id: 1 } }, ...args)
}
let ops: typeof OpsHandlers
beforeEach(async () => {
  vi.resetModules()
  state.handlers.clear()
  state.mode = 'in-app'
  state.service = undefined
  state.run.mockClear()
  ops = await import('./ops-handlers')
  const { registerLocalMachineHandlers } = await import('./local-machine-handlers')
  ops.registerOpsHandlers()
  registerLocalMachineHandlers()
})

it('dispatches only the local surface, deriving authority from the sender', async () => {
  const request = { op: 'whoami', args: {} }
  expect(await invoke('ops:run', { kind: 'local' }, request)).toMatchObject({ status: 'ok' })
  expect(state.run).toHaveBeenCalledWith(
    { kind: 'surface', clientId: '1', label: 'This Mac', via: 'owner' },
    request,
  )
  expect(await invoke('ops:run', { kind: 'remote', hostId: 'host' }, request)).toEqual(
    ops.OPS_HOST_UNREACHABLE,
  )
  expect(state.run).toHaveBeenCalledTimes(1)
})

function fakeHost() {
  return {
    call: vi.fn(async () => ({
      ok: true as const,
      data: { status: 'ok', text: 'read', applies: 'now' },
    })),
    send: vi.fn(async () => ({
      status: 'done' as const,
      data: { status: 'ok', text: 'wrote', applies: 'now' },
    })),
  }
}

it('forwards a Host op over that Host connection: a read is a call, a write a receipt', async () => {
  const host = fakeHost()
  ops.bindOpsHosts((id) => (id === 'h1' ? (host as never) : undefined))
  const target = { kind: 'remote', hostId: 'h1' }
  expect(await invoke('ops:run', target, { op: 'lane.list', args: {} })).toMatchObject({
    text: 'read',
  })
  expect(host.call).toHaveBeenCalledWith('ops.run', { op: 'lane.list', args: {} })
  expect(await invoke('ops:run', target, { op: 'lane.pin', args: { ref: 'x' } })).toMatchObject({
    text: 'wrote',
  })
  expect(host.send).toHaveBeenCalledTimes(1)
  expect(
    await invoke('ops:run', { kind: 'remote', hostId: 'gone' }, { op: 'lane.list', args: {} }),
  ).toEqual(ops.OPS_HOST_UNREACHABLE)
  expect(
    await invoke('ops:run', target, { op: 'x', args: {}, actor: { kind: 'agent' } }),
  ).toMatchObject({ code: 'bad-request' })
  expect(state.run).not.toHaveBeenCalled()
})

it('sends This Mac ops to its service in daemon mode and never to the in-app binding', async () => {
  const service = fakeHost()
  ops.bindOpsHosts((id) => (id === 'mac' ? (service as never) : undefined))
  state.mode = 'daemon'
  const request = { op: 'lane.list', args: {} }
  expect(await invoke('ops:run', { kind: 'local' }, request)).toEqual(ops.OPS_SERVICE_NOT_READY)
  state.service = { hostId: 'mac' }
  expect(await invoke('ops:run', { kind: 'local' }, request)).toMatchObject({ text: 'read' })
  expect(service.call).toHaveBeenCalledTimes(1)
  expect(state.run).not.toHaveBeenCalled()
})

it('reports This Mac as in-app with nothing to move, and refuses every action', () => {
  expect([...state.handlers.keys()].sort()).toEqual([
    'app:localMachine',
    'app:localMachineAction',
    'ops:run',
  ])
  expect(invoke('app:localMachine')).toEqual({ mode: 'in-app', migration: 'not-needed' })
  expect(invoke('app:localMachineAction', 'retry-migration')).toMatchObject({ ok: false })
})

it('refuses service.update when the gate says daemon but its service cannot be reached', async () => {
  const handlers = await import('./local-machine-handlers')
  expect(handlers.bindLocalMachineGate).toBeTypeOf('function')
  handlers.bindLocalMachineGate({
    status: () => ({ mode: 'daemon', migration: 'committed' }),
    retry: vi.fn(),
    consent: vi.fn(),
    onStatus: () => () => {},
  })
  expect(await invoke('app:localMachineAction', 'update-service')).toEqual({
    ok: false,
    message: "This Mac's Phosphor service isn't ready yet. Try again in a moment.",
  })
  expect(state.run).not.toHaveBeenCalled()
  handlers.bindLocalMachineGate(null)
})
