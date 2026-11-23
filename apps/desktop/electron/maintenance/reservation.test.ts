import { beforeEach, expect, it, vi } from 'vitest'
import { fakeLocalService } from '../local-machine/__fixtures__/local-service'

const registry = vi.hoisted(() => ({ live: [] as Array<{ workspacePath: string }> }))
vi.mock('../registry', () => ({ registry: { list: () => registry.live } }))

const CHECKOUT = '/Users/u/repo/.phosphor/worktrees/a'
const access = {
  location: { kind: 'dev' as const, socket: '/tmp/m2b/s.sock', configDir: '/tmp/m2b/config' },
  ownerKey: () => Promise.reject(new Error('unused')),
}

beforeEach(() => {
  vi.resetModules()
  registry.live = []
})

async function daemon() {
  const fake = fakeLocalService()
  const mode = await import('../local-machine/mode')
  mode.decideLocalRuntimeMode('daemon', access)
  ;(await import('../local-machine/same-machine')).bindSameMachine({
    hostId: fake.hostId,
    connection: () => fake.connection,
  })
  return { fake, reservation: await import('./reservation') }
}

it('in-app, a live lane is one in Desktop’s registry and nothing is leased', async () => {
  const reservation = await import('./reservation')
  expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(false)
  registry.live = [{ workspacePath: CHECKOUT }]
  expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(true)
  expect(await reservation.reserveWorkspace(CHECKOUT, 'live', async (free) => free())).toBe(false)
})

it('in daemon mode, a live lane is a running lane in the service’s projection', async () => {
  const { fake, reservation } = await daemon()
  registry.live = [{ workspacePath: CHECKOUT }]
  expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(false)
  fake.lanes = [{ laneId: 'l', cwd: CHECKOUT, activity: 'stopped' }]
  expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(false)
  for (const activity of ['idle', 'working', 'needs-input'] as const) {
    fake.lanes = [{ laneId: 'l', cwd: CHECKOUT, activity }]
    expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(true)
  }
})

it('in daemon mode, counts every checkout as live while the service is not connected', async () => {
  const { fake, reservation } = await daemon()
  fake.state = 'reconnecting'
  expect(reservation.liveLanePaths()).toBeUndefined()
  expect(reservation.workspaceHasLiveLane(CHECKOUT)).toBe(true)
})

it('in daemon mode, runs the work inside a lease and maps a live-lane refusal', async () => {
  const { fake, reservation } = await daemon()
  const held = await reservation.reserveWorkspace(CHECKOUT, 'live', async (free) => {
    expect([...fake.leases.values()]).toEqual([[CHECKOUT]])
    return free()
  })
  expect(held).toBe(true)
  expect(fake.leases.size).toBe(0)
  fake.lanes = [{ laneId: 'l', cwd: CHECKOUT, activity: 'working' }]
  const run = vi.fn()
  await expect(reservation.reserveWorkspace(CHECKOUT, 'Lane running.', run)).rejects.toThrow(
    'Lane running.',
  )
  expect(run).not.toHaveBeenCalled()
})
