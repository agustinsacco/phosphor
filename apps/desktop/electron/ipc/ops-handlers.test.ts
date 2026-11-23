import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error('missing handler')
  return handler({ sender: { id: 1 } }, ...args)
}
beforeEach(async () => {
  vi.resetModules()
  state.handlers.clear()
  const { registerOpsHandlers } = await import('./ops-handlers')
  const { registerLocalMachineHandlers } = await import('./local-machine-handlers')
  registerOpsHandlers()
  registerLocalMachineHandlers()
})

it('answers every ops:run as not served yet, on This Mac and on a Host', () => {
  for (const target of [{ kind: 'local' }, { kind: 'remote', hostId: 'host' }])
    expect(invoke('ops:run', target, { op: 'lane.list', args: {} })).toEqual({
      status: 'denied',
      code: 'unsupported',
      text: 'This version of Phosphor does not run agent ops yet.',
    })
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
