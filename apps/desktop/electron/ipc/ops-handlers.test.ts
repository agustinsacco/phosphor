import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue({ status: 'ok', text: 'local' }),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../ops/service', () => ({ desktopOps: () => ({ run: state.run }) }))
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

it('dispatches only the local surface, deriving authority from the sender', async () => {
  const request = {op:'whoami', args:{}}
  expect(await invoke('ops:run',{kind:'local'},request)).toMatchObject({status:'ok'})
  expect(state.run).toHaveBeenCalledWith({kind:'surface',clientId:'1',label:'This Mac',via:'owner'}, request)
  expect(await invoke('ops:run',{kind:'remote',hostId:'host'},request)).toMatchObject({code:'unsupported'})
  expect(state.run).toHaveBeenCalledTimes(1)
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
