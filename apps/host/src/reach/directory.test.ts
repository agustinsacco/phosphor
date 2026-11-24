import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CONTROL_MACHINE_ROUTES, HOST_HEADERS } from '@phosphor/shared/control-api'
import {
  SELF,
  directoryEntry,
  fakeControl,
  reachControl,
  type ControlAnswer,
  type DirectoryEntryOverrides,
} from './__fixtures__/siblings'
import { REACH_DIRECTORY_TTL_MS, createReachDirectory } from './directory'

const peer = (label: string) => ({ id: randomUUID(), label })

function listing(machines: unknown[], machineReach = true): ControlAnswer {
  return {
    status: 200,
    body: {
      self: { ...SELF, machineReach },
      machines,
      serverTime: new Date().toISOString(),
    },
  }
}

function setup(answer: () => ControlAnswer, clock = { now: Date.now() }) {
  const control = fakeControl(answer)
  const signedIn = { value: true }
  const directory = createReachDirectory({
    control: () => (signedIn.value ? reachControl() : null),
    fetch: control.fetch,
    now: () => clock.now,
  })
  return { directory, calls: control.calls, signedIn, clock }
}

describe('reach directory', () => {
  it('reads the signed sibling list and says why a machine is not ready', async () => {
    const machines: [string, DirectoryEntryOverrides, object][] = [
      ['bee1', {}, { ready: true, online: true }],
      ['bee2', { state: 'stopping' }, { ready: false, online: false, why: 'offline' }],
      [
        'bee3',
        { lastSeenAt: new Date(Date.now() - 120_000).toISOString() },
        { ready: false, online: false, why: 'offline' },
      ],
      ['bee4', { machineReach: false }, { ready: false, online: true, why: 'reach-off' }],
      ['bee5', { machineGrants: false }, { ready: false, online: true, why: 'update-host' }],
      ['bee6', { reachable: false }, { ready: false, online: true, why: 'offline' }],
      ['bee7', { lastSeenAt: null, state: null }, { ready: false, online: false, why: 'offline' }],
    ]
    const peers = machines.map(([label]) => peer(label))
    const { directory, calls } = setup(() =>
      listing(machines.map(([, o], i) => directoryEntry(peers[i]!, o))),
    )
    const read = await directory.read()
    expect(read).toEqual({
      available: true,
      self: SELF,
      machines: machines.map(([, , expected], i) => ({
        id: peers[i]!.id,
        label: peers[i]!.label,
        hostVersion: '0.3.0',
        ...expected,
      })),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET', path: CONTROL_MACHINE_ROUTES.hostMachines })
    expect(calls[0]!.body).toBe('')
    expect(calls[0]!.headers.get(HOST_HEADERS.host)).toBe(SELF.id)
    expect(calls[0]!.headers.get(HOST_HEADERS.signature)).toBeTruthy()
  })

  it('caches for 30 seconds, shares one request, and refetches when asked fresh', async () => {
    const { directory, calls, clock } = setup(() => listing([]))
    const [a, b] = await Promise.all([directory.read(), directory.read()])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
    clock.now += REACH_DIRECTORY_TTL_MS - 1
    await directory.read()
    expect(calls).toHaveLength(1)
    await directory.read({ fresh: true })
    expect(calls).toHaveLength(2)
    clock.now += REACH_DIRECTORY_TTL_MS
    await directory.read()
    expect(calls).toHaveLength(3)
  })

  it('reads reach off on this machine as unavailable', async () => {
    const { directory } = setup(() => listing([], false))
    await expect(directory.read()).resolves.toEqual({ available: false, reason: 'reach-off' })
  })

  it('maps a 404 to an older control plane and keeps that answer for the cache window', async () => {
    const { directory, calls } = setup(() => ({ status: 404, code: 'not-found' }))
    await expect(directory.read()).resolves.toEqual({ available: false, reason: 'control-old' })
    await directory.read()
    expect(calls).toHaveLength(1)
  })

  it.each([
    [{ status: 410, code: 'gone' }, 'signed-out'],
    [{ status: 403, code: 'forbidden' }, 'account-disabled'],
    [{ status: 503, code: 'unavailable' }, 'offline'],
    ['offline', 'offline'],
  ] as const)('maps %j to %s and asks again next time', async (answer, reason) => {
    const { directory, calls } = setup(() => answer)
    await expect(directory.read()).resolves.toEqual({ available: false, reason })
    await directory.read()
    expect(calls).toHaveLength(2)
  })

  it('answers signed-out without asking control before enrollment', async () => {
    const { directory, calls, signedIn } = setup(() => listing([]))
    signedIn.value = false
    await expect(directory.read()).resolves.toEqual({ available: false, reason: 'signed-out' })
    expect(calls).toHaveLength(0)
  })
})
