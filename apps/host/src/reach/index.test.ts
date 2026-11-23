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
  it('stays unbuilt for the run services until B1 binds it', () => {
    expect(createReach()).toBeNull()
    expect(FEATURE).toBeNull()
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

  it.each([
    [
      { machineReach: false },
      'forbidden',
      'Machine reach is off on bee2. Turn it on under Machines.',
    ],
    [{ machineGrants: false }, 'unsupported', 'Update that Host: bee2.'],
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
  const answering = (result: ReachResult) => {
    const run = vi.fn<Reach['run']>(async () => result)
    return { run }
  }

  it('sends a read-tier op as a read and every other tier as a write', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    const remote = reachRemote(reach)
    await expect(remote.run('h', read)).resolves.toEqual(LANE_LIST_OK)
    expect(reach.run).toHaveBeenLastCalledWith('h', read, { write: false })
    const create = { op: 'lane.create', args: { folder: '/w' }, reason: 'Start' }
    await remote.run('h', create)
    expect(reach.run).toHaveBeenLastCalledWith('h', create, { write: true })
  })

  it('takes a tier function on the other machine, never this lane', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    const tier = vi.fn(() => 'read' as const)
    const spec = { ...OP_CATALOG[0]!, name: 'test.op', tier }
    await reachRemote(reach, [spec]).run('h', { op: 'test.op', args: { a: 1 } })
    expect(tier).toHaveBeenCalledWith({ a: 1 }, { self: false })
    expect(reach.run).toHaveBeenLastCalledWith('h', expect.anything(), { write: false })
  })

  it('refuses an op the catalog does not know and never sends it', async () => {
    const reach = answering({ ok: true, data: LANE_LIST_OK })
    await expect(reachRemote(reach).run('h', { op: 'no.such', args: {} })).resolves.toEqual({
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
