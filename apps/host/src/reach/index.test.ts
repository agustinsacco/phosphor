import { describe, expect, it, vi } from 'vitest'
import { CONTROL_MACHINE_ROUTES } from '@phosphor/shared/control-api'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { Reach, ReachResult } from '@phosphor/session-runtime/ops/reach'
import {
  LANE_LIST_OK,
  SELF,
  directoryEntry,
  fakeControl,
  machineGrant,
  reachControl,
  sibling,
  siblingSockets,
  type ControlAnswer,
  type DirectoryEntryOverrides,
  type Sibling,
} from './__fixtures__/siblings'
import { createHostResolver } from '../ops/remote'
import { FEATURE, createMachineReach, createReach, reachOpsResult, reachRemote } from './index'

const read = { op: 'lane.list', args: {} }

function setup(
  siblings: Sibling[],
  options: { overrides?: DirectoryEntryOverrides; directory?: ControlAnswer } = {},
) {
  const control = fakeControl((call) => {
    if (call.path === CONTROL_MACHINE_ROUTES.hostMachines)
      return (
        options.directory ?? {
          status: 200,
          body: {
            self: { ...SELF, machineReach: true },
            machines: siblings.map((s) => directoryEntry(s, options.overrides)),
            serverTime: new Date().toISOString(),
          },
        }
      )
    const target = siblings.find((s) => s.id === JSON.parse(call.body).targetHostId)
    return target ? { status: 200, body: machineGrant(target) } : { status: 404, code: 'not-found' }
  })
  const reach = createMachineReach({
    control: reachControl,
    fetch: control.fetch,
    socket: siblingSockets(siblings),
  })
  return { reach, calls: control.calls }
}

describe('machine reach', () => {
  it('is announced as machine-grants; run builds it through createMachineReach, not the services slot', () => {
    expect(createReach()).toBeNull()
    expect(FEATURE).toBe('machine-grants')
  })

  it('runs one op on a ready sibling through control directory and grant', async () => {
    const bee2 = sibling('bee2')
    const { reach, calls } = setup([bee2])
    await expect(reach.run(bee2.id, read, { write: false })).resolves.toEqual({
      ok: true,
      data: LANE_LIST_OK,
    })
    await reach.run(bee2.id, read, { write: false })
    expect(calls.map((c) => c.path)).toEqual([
      CONTROL_MACHINE_ROUTES.hostMachines,
      CONTROL_MACHINE_ROUTES.hostMachineGrants,
    ])
    expect(bee2.sockets).toHaveLength(1)
    await reach.close()
    expect(bee2.sockets[0]!.client.isOpen()).toBe(false)
  })

  it('sends with the resolved snapshot and lists capability without probing', async () => {
    const bee2 = sibling('bee2')
    const { reach, calls } = setup([bee2])
    const resolver = createHostResolver({ selfIds: () => [SELF.id], directory: reach.directory })
    const budget = {
      now: Date.now,
      deadlineAt: Date.now() + 20_000,
      signal: new AbortController().signal,
    }
    try {
      const resolved = await resolver.resolve([bee2.label], budget)
      if (!resolved.ok || !('hosts' in resolved)) throw new Error('Missing machine')
      const [host] = resolved.hosts
      expect(host?.machine).toMatchObject({ catalogOps: 'unknown', hostVersion: '0.3.0' })
      expect(bee2.sockets).toHaveLength(0)
      await expect(
        reachRemote(reach).run(host!.id, read, { ...budget, target: host!.machine }),
      ).resolves.toEqual(LANE_LIST_OK)
      expect(calls.map(({ path }) => path)).toEqual([
        CONTROL_MACHINE_ROUTES.hostMachines,
        CONTROL_MACHINE_ROUTES.hostMachineGrants,
      ])
      const directory = await reach.directory()
      expect(directory).toMatchObject({ available: true, machines: [{ catalogOps: true }] })
      expect(bee2.sockets).toHaveLength(1)
    } finally {
      await reach.close()
    }
  })

  it('names the version and requested op when an older Host is not enrolled for reach', async () => {
    const bee2 = sibling('bee2')
    const { reach } = setup([bee2], { overrides: { hostVersion: '0.2.99', machineGrants: false } })
    try {
      await expect(reach.run(bee2.id, read, { write: false })).resolves.toMatchObject({
        code: 'unsupported',
        message: expect.stringContaining('bee2 runs Host 0.2.99, which does not serve lane.list'),
      })
      expect(bee2.sockets).toHaveLength(0)
    } finally {
      await reach.close()
    }
  })

  it.each([
    [
      { machineReach: false },
      'forbidden',
      'Machine reach is off on bee2. Turn it on under Machines.',
    ],
    [
      { machineGrants: false },
      'unsupported',
      'bee2 is not enrolled for reach. Update that Host and enable machine reach.',
    ],
    [{ state: 'stopping' }, 'offline', 'bee2 is offline.'],
  ] as const)(
    'refuses a sibling listed %j with plain text and sends nothing',
    async (o, code, message) => {
      const bee2 = sibling('bee2')
      const { reach, calls } = setup([bee2], { overrides: o })
      await expect(reach.run(bee2.id, read, { write: false })).resolves.toEqual({
        ok: false,
        code,
        message,
      })
      expect(calls).toHaveLength(1)
      expect(bee2.sockets).toHaveLength(0)
    },
  )

  it.each([
    [{ status: 404, code: 'not-found' }, 'unsupported', 'does not offer machine reach yet'],
    [{ status: 410, code: 'gone' }, 'forbidden', 'not enrolled'],
    [{ status: 403, code: 'forbidden' }, 'forbidden', 'account is disabled'],
    ['offline', 'offline', 'cannot be reached'],
  ] as const)('reads a directory answer %j as %s', async (directory, code, text) => {
    const { reach } = setup([], { directory })
    const result = await reach.run('0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00', read, { write: false })
    expect(result).toMatchObject({ ok: false, code, message: expect.stringContaining(text) })
  })

  it('refuses this machine and an unknown id before asking for a grant', async () => {
    const { reach, calls } = setup([])
    await expect(reach.run(SELF.id, read, { write: false })).resolves.toMatchObject({
      code: 'bad-request',
      message: 'That is this machine.',
    })
    await expect(
      reach.run('0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00', read, { write: false }),
    ).resolves.toMatchObject({ code: 'bad-request' })
    expect(calls.map((c) => c.path)).toEqual([CONTROL_MACHINE_ROUTES.hostMachines])
  })

  it('lists the directory through the Reach port', async () => {
    const bee2 = sibling('bee2')
    const { reach } = setup([bee2])
    await expect(reach.directory()).resolves.toMatchObject({
      available: true,
      self: SELF,
      machines: [{ id: bee2.id, label: 'bee2', ready: true }],
    })
  })
})

describe('reachRemote', () => {
  const options = {
    now: Date.now,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
  }
  const sent = { signal: options.signal, deadlineAt: options.deadlineAt }
  const answering = (result: ReachResult) => {
    const run = vi.fn<Reach['run']>(async () => result)
    return { run }
  }

  it('sends a read-tier op as a read and every other tier as a write', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    const remote = reachRemote(reach)
    await expect(remote.run('h', read, options)).resolves.toEqual(LANE_LIST_OK)
    expect(reach.run).toHaveBeenLastCalledWith('h', read, { ...sent, write: false })
    const create = { op: 'lane.create', args: { folder: '/w' }, reason: 'Start' }
    await remote.run('h', create, options)
    expect(reach.run).toHaveBeenLastCalledWith('h', create, { ...sent, write: true })
  })

  it('takes a tier function on the other machine, never this lane', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    const tier = vi.fn(() => 'read' as const)
    const spec = { ...OP_CATALOG[0]!, name: 'test.op', tier }
    await reachRemote(reach, [spec]).run('h', { op: 'test.op', args: { a: 1 } }, options)
    expect(tier).toHaveBeenCalledWith({ a: 1 }, { self: false })
    expect(reach.run).toHaveBeenLastCalledWith('h', expect.anything(), { ...sent, write: false })
  })

  it('refuses an op the catalog does not know and never sends it', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    await expect(
      reachRemote(reach).run('h', { op: 'no.such', args: {} }, options),
    ).resolves.toEqual({
      status: 'denied',
      code: 'bad-request',
      text: 'Unknown operation: no.such.',
    })
    expect(reach.run).not.toHaveBeenCalled()
  })
})

describe('reachOpsResult', () => {
  it('returns the target own answer, in-band denials and confirmations included', () => {
    const denied: OpsRunResult = { status: 'denied', code: 'busy', text: 'A turn is running.' }
    expect(reachOpsResult({ ok: true, data: LANE_LIST_OK })).toEqual(LANE_LIST_OK)
    expect(reachOpsResult({ ok: false, code: 'denied', message: 'x', data: denied })).toEqual(
      denied,
    )
  })

  it.each([
    ['unsupported', 'unsupported'],
    ['forbidden', 'forbidden'],
    ['offline', 'unavailable'],
    ['timeout', 'unavailable'],
    ['unconfirmed', 'unavailable'],
    ['too-large', 'too-large'],
    ['bad-request', 'bad-request'],
    ['denied', 'limit'],
  ] as const)('reads a local %s refusal as denied %s with its text', (code, deny) => {
    expect(reachOpsResult({ ok: false, code, message: 'Plain text.' })).toEqual({
      status: 'denied',
      code: deny,
      text: 'Plain text.',
    })
  })

  it('refuses an answer it cannot read', () => {
    expect(reachOpsResult({ ok: true, data: { status: 'maybe' } })).toMatchObject({
      status: 'denied',
      code: 'unavailable',
    })
  })
})
