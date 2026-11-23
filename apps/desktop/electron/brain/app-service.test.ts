import { afterEach, expect, it, vi } from 'vitest'
import type { BrainService } from '@phosphor/brain-runtime/types'
import { BrainAppService } from './app-service'

const registration = (recall: boolean) => ({
  service: 'brain' as const,
  endpoint: '/fake',
  token: 'fixture',
  recall,
})
const bridge = { registration, close: vi.fn() }
const app = () => new BrainAppService(async () => bridge)
const apps: BrainAppService[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((s) => s.dispose()))
})
function setup() {
  const service = app()
  apps.push(service)
  let recall = true
  service.install(
    async () => ({ recallLaunch: async () => (recall ? {} : undefined) }) as BrainService,
    vi.fn(),
  )
  const view = {
    state: 'ready',
    connectionToken: 'first',
    ownerLocal: true,
    cursor: { epoch: 'e', seq: 1 },
    lanes: [{ laneId: 'id', activity: 'working' }],
  }
  const call = vi.fn(
    async (_method: string, _params?: unknown): Promise<{ ok: boolean; data: unknown }> => ({
      ok: true,
      data: { registered: true },
    }),
  )
  const connection = { snapshot: () => view, call }
  return {
    service,
    view,
    call,
    connection,
    setRecall: (value: boolean) => {
      recall = value
      service.brainChanged()
    },
  }
}

it('registers only on the attested connection; sends changed recall and registers again after reconnect', async () => {
  const { service, view, call, connection, setRecall } = setup()
  view.ownerLocal = false
  service.ownerChanged(connection)
  expect(call).not.toHaveBeenCalled()
  view.ownerLocal = true
  service.ownerChanged(connection)
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('app.service.register', registration(true)),
  )
  service.ownerChanged(connection)
  setRecall(true)
  setRecall(false)
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(call).toHaveBeenLastCalledWith('app.service.register', registration(false))
  service.ownerChanged(undefined)
  view.connectionToken = 'second'
  service.ownerChanged(connection)
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3))
  expect(call).toHaveBeenLastCalledWith('app.service.register', registration(false))
})

it('joins working and needs-input lanes to exact session files, waiting when the owner/index is unavailable', async () => {
  const { service, view, connection, call } = setup()
  expect(service.busy('/a')).toBe(true)
  call.mockImplementation(async (method, params) => ({
    ok: true,
    data:
      method !== 'owner.index'
        ? { registered: true }
        : (params as { after?: string }).after
          ? { lanes: [{ laneId: 'id', sessionFile: '/a' }] }
          : { lanes: [], next: 'before-id' },
  }))
  service.ownerChanged(connection)
  expect(service.busy('/other')).toBe(true)
  await vi.waitFor(() => expect(service.busy('/other')).toBe(false))
  expect(service.busy('/a')).toBe(true)
  view.cursor.seq++
  view.lanes[0]!.activity = 'needs-input'
  service.ownerChanged(connection)
  expect(service.busy('/a')).toBe(true)
  view.cursor.seq++
  view.lanes[0]!.activity = 'idle'
  service.ownerChanged(connection)
  expect(service.busy('/a')).toBe(false)
  service.ownerChanged(undefined)
  expect(service.busy('/other')).toBe(true)
})

it('ignores cached idle rows until the new connection receives its initial lanes frame', () => {
  const { service, view, connection } = setup()
  view.lanes = []
  service.ownerChanged(connection)
  expect(service.busy('/lane')).toBe(true)
  service.lanesSnapshot()
  service.ownerChanged(connection)
  expect(service.busy('/lane')).toBe(false)
  service.ownerChanged(undefined)
  view.connectionToken = 'reconnected'
  service.ownerChanged(connection)
  // ready and pending-command replay both notify before the first snapshot arrives.
  service.ownerChanged(connection)
  expect(service.busy('/lane')).toBe(true)
  service.lanesSnapshot()
  service.ownerChanged(connection)
  expect(service.busy('/lane')).toBe(false)
})
