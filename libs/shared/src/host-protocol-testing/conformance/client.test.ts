import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseClientFrame,
  type ClientFrame,
  type FrameSocket,
  type HostFrame,
} from '../../host-protocol'
import { createConformanceHarness } from './__fixtures__/harness'
import {
  auth,
  challenge,
  client,
  command,
  create,
  events,
  receipts,
  snapshots,
  type ClientPorts,
} from './client'

/** Captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout
const LANE = '00000000-0000-4000-8000-0000000000a1'
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

/** A harness whose socket is scripted: `answer` sees each sent frame and may reply. */
function scripted(
  answer: (frame: ClientFrame, reply: (frame: HostFrame | string) => void) => void,
  repositoryId?: string,
) {
  const sent: ClientFrame[] = []
  let deliver: (text: string) => void = () => {}
  let close: (code: number, reason: string) => void = () => {}
  const reply = (frame: HostFrame | string) =>
    deliver(typeof frame === 'string' ? frame : JSON.stringify(frame))
  const socket: FrameSocket = {
    send(text) {
      const parsed = parseClientFrame(text)
      if (!parsed.ok) throw new Error('Invalid client frame: ' + parsed.reason)
      sent.push(parsed.frame)
      answer(parsed.frame, reply)
    },
    close: (code, reason) => close(code, reason),
    onMessage: (cb) => void (deliver = cb),
    onClose: (cb) => void (close = cb),
    isOpen: () => true,
    bufferedBytes: () => 0,
  }
  const harness = {
    ...createConformanceHarness({}),
    repositoryId,
    connect: () => ({ socket, pause() {}, resume() {}, sever() {} }),
  }
  const ports: ClientPorts = { current: () => harness, flush, expect }
  return { ports, sent, reply, socket }
}
const done = (requestId: string, laneId?: string): HostFrame => ({
  type: 'receipt',
  receipt: { requestId, status: 'done', ...(laneId ? { laneId } : {}) },
})

describe('client', () => {
  it('parses each Host frame into the viewer and records close codes', () => {
    const { ports, reply, sent, socket } = scripted(() => {})
    const viewer = client(ports)
    reply({ type: 'pong', at: 7 })
    socket.close(4401, 'Expired')
    expect(viewer.frames).toEqual([{ type: 'pong', at: 7 }])
    expect(viewer.closed).toEqual([4401])
    viewer.send({ type: 'ping', at: 1 })
    expect(sent).toEqual([{ type: 'ping', at: 1 }])
    expect(viewer.socket).toBe(socket)
  })

  it('throws on a frame the Host protocol does not parse', () => {
    const { ports, reply } = scripted(() => {})
    const viewer = client(ports)
    expect(() => reply('{"type":"nonsense"}')).toThrow(/^Invalid Host frame: /)
    expect(viewer.frames).toEqual([])
  })
})

describe('auth', () => {
  it('sends the minted grant with the fixed challenge and expects ready first', async () => {
    const harness = createConformanceHarness({})
    const viewer = await auth(
      { current: () => harness, flush, expect },
      { caps: ['sessions.read'] },
    )
    expect(viewer.frames[0]).toMatchObject({ type: 'ready', capabilities: ['sessions.read'] })
    expect(challenge).toBe('a'.repeat(64))
    harness.driver.stop()
  })
})

describe('receipts, events and snapshots', () => {
  it('select receipts by request id, and events by subscription id', () => {
    const one = '00000000-0000-4000-8000-000000000001',
      two = '00000000-0000-4000-8000-000000000002'
    const frames: HostFrame[] = [
      done(one),
      { type: 'pong', at: 1 },
      { type: 'receipt', receipt: { requestId: two, status: 'pending' } },
      done(two),
    ]
    expect(receipts({ frames }).map((r) => r.requestId)).toEqual([one, two, two])
    expect(receipts({ frames }, two).map((r) => r.status)).toEqual(['pending', 'done'])
    expect(events({ frames })).toEqual([])
    expect(snapshots({ frames })).toEqual([])
  })
})

describe('create', () => {
  it('looks up the first repository when the harness names none', async () => {
    const { ports, sent } = scripted((frame, reply) => {
      if (frame.type === 'call')
        reply({
          type: 'result',
          id: frame.id,
          ok: true,
          data: [{ id: '00000000000000a1' }, { id: 'x' }],
        })
      if (frame.type === 'command') reply(done(frame.requestId, LANE))
    })
    const viewer = client(ports)
    expect(await create(ports, viewer)).toBe(LANE)
    expect(sent.map((f) => (f.type === 'command' ? f.op : f.type))).toEqual([
      'call',
      { type: 'lane.create', repositoryId: '00000000000000a1', worktree: null },
    ])
  })

  it('uses the harness repository without a lookup', async () => {
    const { ports, sent } = scripted((frame, reply) => {
      if (frame.type === 'command') reply(done(frame.requestId, LANE))
    }, '00000000000000b2')
    expect(await create(ports, client(ports))).toBe(LANE)
    expect(sent).toMatchObject([{ type: 'command', op: { repositoryId: '00000000000000b2' } }])
  })

  it('fails without a repository list, a repository id or a created lane', async () => {
    const empty = scripted(() => {})
    await expect(create(empty.ports, client(empty.ports))).rejects.toThrow('Missing repositories')
    const unnamed = scripted((frame, reply) => {
      if (frame.type === 'call') reply({ type: 'result', id: frame.id, ok: true, data: [{}] })
    })
    await expect(create(unnamed.ports, client(unnamed.ports))).rejects.toThrow(
      'Missing repository id',
    )
    const laneless = scripted((frame, reply) => {
      if (frame.type === 'command') reply(done(frame.requestId))
    }, '00000000000000b2')
    await expect(create(laneless.ports, client(laneless.ports))).rejects.toThrow('No created lane')
  })
})

describe('command', () => {
  it('returns the latest receipt for its request after a 5 ms flush', async () => {
    const { ports, sent } = scripted((frame, reply) => {
      if (frame.type !== 'command') return
      reply({ type: 'receipt', receipt: { requestId: frame.requestId, status: 'pending' } })
      setTimeout(() => reply(done(frame.requestId)), 5)
    })
    const receipt = await command(ports, client(ports), LANE, { type: 'abort' }, 3)
    expect(receipt.status).toBe('done')
    expect(sent).toMatchObject([{ type: 'command', laneId: LANE, fence: 3, op: { type: 'abort' } }])
    expect(Date.now() - T0).toBe(5)
  })

  it('waits for a receipt answered on a real timer without moving fake time', async () => {
    const { ports } = scripted((frame, reply) => {
      if (frame.type === 'command') realSetTimeout(() => reply(done(frame.requestId)), 20)
    })
    const receipt = await command(ports, client(ports), LANE, { type: 'lane.stop' })
    expect(receipt.status).toBe('done')
    expect(Date.now() - T0).toBe(5)
  })

  it('gives up with Missing receipt after bounded real yields, still at the 5 ms flush', async () => {
    const { ports, sent } = scripted(() => {})
    await expect(command(ports, client(ports), LANE, { type: 'abort' })).rejects.toThrow(
      'Missing receipt',
    )
    expect(sent).toMatchObject([{ fence: 1 }])
    expect(Date.now() - T0).toBe(5)
  })
})
