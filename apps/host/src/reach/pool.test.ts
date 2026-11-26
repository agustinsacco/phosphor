import { describe, expect, it, vi } from 'vitest'
import type { ClientFrame } from '@phosphor/shared/host-protocol'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import {
  LANE_LIST_OK,
  machineGrant,
  sibling,
  siblingSockets,
  type Sibling,
} from './__fixtures__/siblings'
import { ReachGrantRefused } from './grants'
import { createReachPool, type ReachPoolLimits } from './pool'

const read = { op: 'lane.list', args: {} }
const write = { op: 'lane.create', args: { folder: '/w' }, reason: 'Start the fix' }

function setup(siblings: Sibling[], limits: Partial<ReachPoolLimits> = {}) {
  const clock = { now: Date.now() }
  const grants = {
    grantFor: vi.fn(async (id: string) => {
      const target = siblings.find((s) => s.id === id)
      if (!target) throw new ReachGrantRefused('unknown')
      return machineGrant(target)
    }),
    clear: vi.fn(),
  }
  const pool = createReachPool({
    grants,
    socket: siblingSockets(siblings),
    now: () => clock.now,
    limits,
  })
  return { pool, grants, clock }
}

const opsFrames = (s: Sibling) =>
  s.sent.filter(
    (f: ClientFrame) =>
      (f.type === 'call' && f.method === 'ops.run') ||
      (f.type === 'command' && f.op.type === 'ops.run'),
  )

/** A handler whose answers the test releases. */
function held() {
  const waiting: ((result: OpsRunResult) => void)[] = []
  return {
    handler: () => new Promise<OpsRunResult>((resolve) => waiting.push(resolve)),
    waiting,
  }
}

describe('reach pool', () => {
  it('sends a read as a call and a write as a command on one ops-only connection', async () => {
    const bee2 = sibling('bee2')
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, read, { write: false })).resolves.toEqual({
      ok: true,
      data: LANE_LIST_OK,
    })
    await expect(pool.run(bee2, write, { write: true })).resolves.toMatchObject({ ok: true })
    expect(bee2.ops).toEqual([
      { op: 'lane.list', write: false },
      { op: 'lane.create', write: true },
    ])
    expect(bee2.sockets).toHaveLength(1)
    expect(bee2.sent.some((f) => f.type === 'subscribe')).toBe(false)
    const command = bee2.sent.find((f) => f.type === 'command')
    expect(command).toMatchObject({ op: { type: 'ops.run', op: 'lane.create' } })
    expect(command && 'fence' in command ? command.fence : undefined).toBeUndefined()
    pool.close()
  })

  it('keeps the target own answer for confirmations and in-band denials', async () => {
    const confirm: OpsRunResult = {
      status: 'confirm',
      confirmId: '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00',
      digest: 'a'.repeat(64),
      title: 'Delete two lanes?',
      message: 'Two lanes.',
      items: [{ hostId: null, op: 'lane.delete', ids: ['a'], labels: ['A'] }],
      expiresAt: Date.now() + 60_000,
    }
    const denied: OpsRunResult = { status: 'denied', code: 'busy', text: 'A turn is running.' }
    const answers = [confirm, denied]
    const bee2 = sibling('bee2', () => answers.shift() ?? LANE_LIST_OK)
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, write, { write: true })).resolves.toEqual({
      ok: false,
      code: 'needs-confirm',
      message: 'Delete two lanes?',
      data: confirm,
    })
    await expect(pool.run(bee2, write, { write: true })).resolves.toEqual({
      ok: false,
      code: 'denied',
      message: 'A turn is running.',
      data: denied,
    })
    pool.close()
  })

  it('answers unsupported "Update that Host" when ready has no ops, and sends nothing', async () => {
    const old = sibling('old', null)
    const { pool } = setup([old])
    await expect(pool.run(old, read, { write: false })).resolves.toEqual({
      ok: false,
      code: 'unsupported',
      message: 'old runs Host 0.0.0, which does not serve lane.list. Update that Host.',
    })
    expect(opsFrames(old)).toEqual([])
    pool.close()
  })

  it('tries a read once more on a new connection after the first one drops', async () => {
    let calls = 0
    const bee2: Sibling = sibling('bee2', () => {
      calls++
      if (calls > 1) return LANE_LIST_OK
      bee2.sockets[0]!.sever()
      return new Promise<OpsRunResult>(() => {})
    })
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, read, { write: false })).resolves.toEqual({
      ok: true,
      data: LANE_LIST_OK,
    })
    expect(bee2.sockets).toHaveLength(2)
    expect(bee2.ops).toHaveLength(2)
    pool.close()
  })

  it('never resends a write after a drop and reports it unconfirmed', async () => {
    const bee2: Sibling = sibling('bee2', () => {
      bee2.sockets[0]!.sever()
      return new Promise<OpsRunResult>(() => {})
    })
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, write, { write: true })).resolves.toEqual({
      ok: false,
      code: 'unconfirmed',
      message: 'bee2 did not confirm the change. Check it before you try again.',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bee2.sockets).toHaveLength(1)
    expect(opsFrames(bee2)).toHaveLength(1)
    expect(pool.size()).toBe(0)
  })

  it('reports a deadline after dispatch as unconfirmed without sending again', async () => {
    const answer = held()
    const bee2 = sibling('bee2', answer.handler)
    const { pool, clock } = setup([bee2])
    const controller = new AbortController()
    try {
      const result = pool.run(bee2, write, {
        write: true,
        signal: controller.signal,
        deadlineAt: clock.now + 1000,
      })
      await vi.waitFor(() => expect(answer.waiting).toHaveLength(1))
      controller.abort()
      answer.waiting[0]!(LANE_LIST_OK)
      await expect(result).resolves.toMatchObject({ ok: false, code: 'unconfirmed' })
      expect(opsFrames(bee2)).toHaveLength(1)
    } finally {
      pool.close()
    }
  })

  it('reports an unknown receipt as unconfirmed', async () => {
    const bee2 = sibling('bee2', () => {
      throw new Error('lost track')
    })
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, write, { write: true })).resolves.toMatchObject({
      ok: false,
      code: 'unconfirmed',
    })
    expect(opsFrames(bee2)).toHaveLength(1)
    pool.close()
  })

  it('tries a read at most twice', async () => {
    const bee2: Sibling = sibling('bee2', () => {
      bee2.sockets.at(-1)!.sever()
      return new Promise<OpsRunResult>(() => {})
    })
    const { pool } = setup([bee2])
    await expect(pool.run(bee2, read, { write: false })).resolves.toEqual({
      ok: false,
      code: 'offline',
      message: 'bee2 is unreachable on your tailnet.',
    })
    expect(bee2.sockets).toHaveLength(2)
    pool.close()
  })

  it('leaves a target that closed 4403 alone for a minute', async () => {
    const bee2 = sibling('bee2')
    const { pool, grants, clock } = setup([bee2])
    await pool.run(bee2, read, { write: false })
    bee2.driver.revokeClient(bee2.clientId)
    await vi.waitFor(() => expect(pool.size()).toBe(0))
    expect(grants.clear).toHaveBeenCalledWith(bee2.id)
    await expect(pool.run(bee2, read, { write: false })).resolves.toEqual({
      ok: false,
      code: 'forbidden',
      message: 'bee2 refused this machine recently. Try again in a minute.',
    })
    expect(bee2.sockets).toHaveLength(1)
    clock.now += 60_000
    await expect(pool.run(bee2, read, { write: false })).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('bee2 refused this machine.'),
    })
    expect(bee2.sockets).toHaveLength(2)
    pool.close()
  })

  it('closes an idle connection', async () => {
    const bee2 = sibling('bee2')
    const { pool } = setup([bee2], { idleMs: 20 })
    await pool.run(bee2, read, { write: false })
    expect(pool.size()).toBe(1)
    await vi.waitFor(() => expect(pool.size()).toBe(0))
    pool.close()
  })

  it('holds at most the open limit, evicting the least recently used idle one', async () => {
    const hold = held()
    const busy = [sibling('bee1', hold.handler), sibling('bee2', hold.handler)]
    const bee3 = sibling('bee3')
    const { pool, clock } = setup([...busy, bee3], { open: 2 })
    const running = busy.map((s) => pool.run(s, read, { write: false }))
    await vi.waitFor(() => expect(hold.waiting).toHaveLength(2))
    await expect(pool.run(bee3, read, { write: false })).resolves.toEqual({
      ok: false,
      code: 'denied',
      message: 'Phosphor is already talking to 2 machines. Try again shortly.',
    })
    hold.waiting[1]!(LANE_LIST_OK)
    await running[1]
    clock.now += 1
    hold.waiting[0]!(LANE_LIST_OK)
    await running[0]
    await expect(pool.run(bee3, read, { write: false })).resolves.toMatchObject({ ok: true })
    expect(pool.size()).toBe(2)
    await vi.waitFor(() => expect(busy[1]!.sockets[0]!.client.isOpen()).toBe(false))
    pool.close()
  })

  it('reports a target that never connects as unreachable on the tailnet', async () => {
    const bee2 = sibling('bee2')
    const pool = createReachPool({
      grants: { grantFor: async () => machineGrant(bee2), clear: () => {} },
      socket: () => new Promise(() => {}),
      limits: { connectMs: 20 },
    })
    await expect(pool.run(bee2, read, { write: false })).resolves.toEqual({
      ok: false,
      code: 'timeout',
      message: 'bee2 is unreachable on your tailnet.',
    })
    expect(pool.size()).toBe(0)
  })

  it('refuses an endpoint the injected check does not allow, without opening a socket', async () => {
    const bee2 = sibling('bee2')
    const socket = vi.fn(siblingSockets([bee2]))
    const pool = createReachPool({
      grants: { grantFor: async () => machineGrant(bee2), clear: () => {} },
      socket,
      endpointAllowed: () => false,
    })
    await expect(pool.run(bee2, read, { write: false })).resolves.toMatchObject({
      ok: false,
      code: 'offline',
    })
    expect(socket).not.toHaveBeenCalled()
  })

  it.each([
    ['reach-off', 'forbidden', 'Machine reach is off for bee2 or for this machine.'],
    ['unavailable', 'offline', 'bee2 is offline, has no tailnet address'],
    ['signed-out', 'forbidden', 'This machine is not enrolled'],
    ['rate-limited', 'denied', 'rate-limited the request'],
  ] as const)('reads a %s grant refusal as %s', async (reason, code, text) => {
    const bee2 = sibling('bee2')
    const pool = createReachPool({
      grants: {
        grantFor: () => Promise.reject(new ReachGrantRefused(reason)),
        clear: () => {},
      },
      socket: siblingSockets([bee2]),
    })
    const result = await pool.run(bee2, read, { write: false })
    expect(result).toMatchObject({ ok: false, code, message: expect.stringContaining(text) })
    expect(bee2.sockets).toHaveLength(0)
  })

  it('stops waiting when the signal aborts before the target is ready', async () => {
    const bee2 = sibling('bee2')
    const { pool } = setup([bee2])
    const signal = AbortSignal.abort()
    await expect(pool.run(bee2, write, { write: true, signal })).resolves.toEqual({
      ok: false,
      code: 'timeout',
      message: 'Stopped before reaching bee2.',
    })
    expect(opsFrames(bee2)).toEqual([])
    pool.close()
  })
})
