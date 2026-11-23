import { expect, it, vi } from 'vitest'
import { fakeLocalService } from '../local-machine/__fixtures__/local-service'

/** The local slot reaches the same-machine routes, and leaves them when it detaches. */

const mocks = vi.hoisted(() => ({
  attach: undefined as undefined | ((slot: { hostId: string } | null) => void),
  setLocal: vi.fn(),
  connection: vi.fn(),
}))
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: {}, Notification: {} }))
vi.mock('../account', () => ({ accountUserId: vi.fn(), onAccountChange: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({
  getRemoteClients: vi.fn(),
  setRemoteClients: vi.fn(),
  getConfigureHosts: vi.fn(),
  setConfigureHosts: vi.fn(),
}))
vi.mock('../hosts/client-id', () => ({ createClientIds: () => ({}) }))
vi.mock('../hosts/grants', () => ({ createGrants: () => ({}) }))
vi.mock('../hosts/connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('../hosts/manager', () => ({
  createHostManager: () => ({
    snapshot: () => ({}),
    connection: mocks.connection,
    setLocal: mocks.setLocal,
  }),
}))
vi.mock('../hosts/socket', () => ({ openHostSocket: vi.fn(), e2eHostEndpoint: () => undefined }))
vi.mock('./control-handlers', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({ handle: vi.fn(), setRemoteReadRouter: vi.fn() }))
vi.mock('../hosts/remote-lanes', () => ({ createRemoteLanes: () => ({}) }))
vi.mock('../hosts/attention', () => ({ createHostAttention: () => ({}) }))
vi.mock('../local-machine/mode', () => ({
  onDaemonMode: (listener: (access: unknown) => void) => listener({}),
}))
vi.mock('../local-machine/connection', () => ({
  startLocalMachine: (ports: { attach: NonNullable<typeof mocks.attach> }) => {
    mocks.attach = ports.attach
    return { stop: vi.fn() }
  },
}))

import { sameMachine } from '../local-machine/same-machine'
import { registerHostsHandlers } from './hosts-handlers'

it('binds the local slot for same-machine routes and unbinds it on detach or a lost connection', () => {
  const fake = fakeLocalService('mac-0001')
  registerHostsHandlers()
  if (!mocks.attach) throw new Error('The local machine was not admitted')
  expect(sameMachine()).toBeUndefined()
  mocks.connection.mockImplementation((id: string) =>
    id === 'mac-0001' ? fake.connection : undefined,
  )
  const slot = { hostId: 'mac-0001', label: 'This Mac', create: vi.fn() }
  mocks.attach(slot)
  expect(mocks.setLocal).toHaveBeenLastCalledWith(slot)
  expect(sameMachine()?.hostId).toBe('mac-0001')
  fake.state = 'down'
  expect(sameMachine()).toBeUndefined()
  fake.state = 'ready'
  mocks.connection.mockReturnValue(undefined)
  expect(sameMachine()).toBeUndefined()
  mocks.connection.mockReturnValue(fake.connection)
  expect(sameMachine()?.hostId).toBe('mac-0001')
  mocks.attach(null)
  expect(mocks.setLocal).toHaveBeenLastCalledWith(null)
  expect(sameMachine()).toBeUndefined()
})
