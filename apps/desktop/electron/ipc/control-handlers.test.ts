import { randomBytes } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  token: null as string | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', once: () => undefined },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../hosts/traffic-tap', () => ({ tappedLog: vi.fn() }))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
vi.mock('../account', () => ({
  accountAccessToken: async () => state.token,
  accountControlGeneration: () => 0,
  // Signed out: the live socket must stay closed.
  accountSnapshot: () => ({ account: { status: 'signed-out' } }),
  onAccountChange: () => () => undefined,
}))
const fetchImpl = vi.fn()
beforeEach(async () => {
  vi.resetModules()
  state.handlers.clear()
  state.token = randomBytes(32).toString('base64url')
  fetchImpl.mockReset()
  vi.stubGlobal('fetch', fetchImpl)
  const { registerControlHandlers } = await import('./control-handlers')
  registerControlHandlers()
})
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error('missing handler')
  return handler({}, ...args)
}
it('registers the channels and rejects malformed renderer inputs before a request', async () => {
  expect(state.handlers.size).toBe(6)
  for (const [channel, args] of [
    ['control:setMachineReach', ['../bad', true]],
    ['control:setMachineReach', ['11111111-1111-4111-8111-111111111111', 1]],
    ['control:lookupEnrollment', [7]],
    ['control:renameMachine', ['../bad', 'x']],
    ['control:renameMachine', ['11111111-1111-4111-8111-111111111111', '']],
    ['control:approveEnrollment', ['BCDFGHJK', {}]],
    ['control:approveEnrollment', ['wrong', 'bee1']],
    ['control:removeMachine', ['../../x']],
  ] satisfies [string, unknown[]][]) {
    expect(await invoke(channel, ...args)).toMatchObject({ error: { code: 'bad-request' } })
  }
  expect(fetchImpl).not.toHaveBeenCalled()
})
it('returns signed-out for every channel without a token and sends no request', async () => {
  state.token = null
  for (const [channel, args] of [
    ['control:setMachineReach', ['11111111-1111-4111-8111-111111111111', true]],
    ['control:machines', []],
    ['control:lookupEnrollment', ['BCDFGHJK']],
    ['control:approveEnrollment', ['BCDFGHJK', 'bee1']],
    ['control:removeMachine', ['11111111-1111-4111-8111-111111111111']],
    ['control:renameMachine', ['11111111-1111-4111-8111-111111111111', 'new-label']],
  ] satisfies [string, unknown[]][])
    expect(await invoke(channel, ...args)).toMatchObject({ error: { code: 'signed-out' } })
  expect(fetchImpl).not.toHaveBeenCalled()
})
it.each([200, 404])('PATCHes the enrolled machine reach route (HTTP %s)', async (status) => {
  const id = '11111111-1111-4111-8111-111111111111'
  fetchImpl
    .mockResolvedValueOnce(
      Response.json({ account: { login: 'octo' }, enabled: true, maxHosts: 20 }),
    )
    .mockResolvedValueOnce(
      status === 200 ? Response.json({ machineReach: false }) : new Response(null, { status }),
    )
  expect(await invoke('control:setMachineReach', id, false)).toMatchObject(
    status === 200
      ? { ok: true, machineReach: false }
      : { ok: false, error: { code: 'not-found' } },
  )
  const [url, options] = fetchImpl.mock.calls[1]!
  expect(url.pathname).toBe(`/api/v1/machines/${id}/reach`)
  expect(options).toMatchObject({ method: 'PATCH', body: '{"enabled":false}' })
})
