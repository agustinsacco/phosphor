import { describe, expect, it } from 'vitest'
import type { ClientFrame, HostFrame } from '@shared/host-protocol'
import { createTrafficLog, TRAFFIC_PAGE } from './traffic-log'

const SECRET = 'SECRET-PAYLOAD-7f3a'
function clock(start = 1_000) {
  let at = start
  return { now: () => at, tick: (ms: number) => (at += ms) }
}

describe('traffic log', () => {
  it('records names, ids, sizes and timings, never a payload, grant or terminal data', () => {
    const time = clock()
    const traffic = createTrafficLog({ now: time.now })
    const out = (frame: unknown) => traffic.frame('h1', 'out', frame as ClientFrame, 99)
    const inbound = (frame: unknown) => traffic.frame('h1', 'in', frame as HostFrame, 99)
    out({ type: 'auth', grant: SECRET, challenge: 'c', trace: 't' })
    out({ type: 'terminal.input', terminalId: 'term-1234567890', seq: 1, data: SECRET })
    out({ type: 'call', id: 'call-1', method: 'machine.providers', params: { secret: SECRET } })
    out({
      type: 'command',
      requestId: 'req-1',
      laneId: 'lane-abcdef123',
      op: { type: 'lane.prompt', message: SECRET },
    })
    time.tick(42)
    inbound({ type: 'result', id: 'call-1', ok: true, data: { secret: SECRET } })
    inbound({ type: 'receipt', receipt: { requestId: 'req-1', status: 'done', data: SECRET } })
    inbound({
      type: 'event',
      id: 's',
      laneId: 'lane-abcdef123',
      cursor: { epoch: 'e', seq: 1 },
      event: {
        kind: 'pi',
        push: { kind: 'event', event: { type: 'message_update', text: SECRET } },
      },
    })
    inbound({ type: 'terminal.output', id: 'x', terminalId: 'term-1', seq: 1, data: SECRET })
    inbound({ type: 'error', code: 4403, message: SECRET })

    const { entries } = traffic.read(0)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
    expect(entries.map((e) => [e.direction, e.kind, e.detail])).toEqual([
      ['out', 'auth', 'handshake'],
      ['out', 'terminal.input', 'terminal term-123'],
      ['out', 'call', 'machine.providers'],
      ['out', 'command', 'lane.prompt · lane lane-abc'],
      ['in', 'result', 'machine.providers'],
      ['in', 'receipt', 'lane.prompt · done'],
      ['in', 'event', 'message_update · lane lane-abc'],
      ['in', 'terminal.output', 'terminal term-1'],
      ['in', 'error', undefined],
    ])
    expect(entries[4]).toMatchObject({ ms: 42, outcome: 'ok', bytes: 99, hostId: 'h1' })
    expect(entries[5]).toMatchObject({ ms: 42, outcome: 'ok' })
    expect(entries[8]).toMatchObject({ outcome: 'error', code: '4403' })
  })

  it('names failed calls and rejected commands by their error code', () => {
    const traffic = createTrafficLog()
    traffic.frame('h1', 'out', { type: 'call', id: 'a', method: 'machine.claude' }, 1)
    traffic.frame(
      'h1',
      'in',
      { type: 'result', id: 'a', ok: false, error: { code: 'unsupported', message: SECRET } },
      1,
    )
    traffic.frame(
      'h1',
      'in',
      { type: 'receipt', receipt: { requestId: 'zz', status: 'rejected', code: 'not-controller' } },
      1,
    )
    const { entries } = traffic.read(0)
    expect(entries[1]).toMatchObject({
      detail: 'machine.claude',
      outcome: 'error',
      code: 'unsupported',
    })
    expect(entries[2]).toMatchObject({
      detail: 'command · rejected',
      outcome: 'error',
      code: 'not-controller',
    })
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('mirrors only named fields from control calls and Host lifecycle lines', () => {
    const traffic = createTrafficLog()
    traffic.observe('control', 'call', {
      method: 'GET',
      route: '/v1/machines',
      status: 200,
      ms: 12,
      code: null,
      trace: SECRET,
      authorization: SECRET,
    })
    traffic.observe('control', 'call', {
      method: 'POST',
      route: '/v1/grants',
      status: 0,
      code: 'TypeError',
    })
    traffic.observe('hosts', 'closed', { hostId: 'h1', code: 4403, ms: 5, secret: SECRET })
    traffic.observe('machines', 'observed', {
      hostId: 'h1',
      label: SECRET,
      from: 'offline',
      to: 'online',
    })
    traffic.observe('hosts', 'receipt', { hostId: 'h1' })
    traffic.observe('pi', 'stderr', { text: SECRET })
    const { entries } = traffic.read(0)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({
      peer: 'control',
      direction: 'call',
      kind: 'GET /v1/machines',
      ms: 12,
      outcome: 'ok',
      code: '200',
    })
    expect(entries[1]).toMatchObject({ outcome: 'error', code: 'TypeError' })
    expect(entries[2]).toMatchObject({ direction: 'state', kind: 'closed', detail: 'code 4403' })
    expect(entries[3]).toMatchObject({ kind: 'machine', detail: 'offline → online' })
  })

  it('keeps a bounded window and reports what a reader missed', () => {
    const traffic = createTrafficLog({ limit: 10 })
    for (let i = 0; i < 25; i++) traffic.state('h1', 'tick')
    const first = traffic.read(0)
    expect(first.entries.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
    expect(first.last).toBe(25)
    expect(traffic.read(25)).toEqual({ entries: [], last: 25, gap: false })
    expect(traffic.read(20).entries.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25])
    expect(traffic.read(3).gap).toBe(true)
  })

  it('pages at most TRAFFIC_PAGE entries, newest first kept', () => {
    const traffic = createTrafficLog({ limit: TRAFFIC_PAGE * 2 })
    for (let i = 0; i < TRAFFIC_PAGE + 5; i++) traffic.state('h1', 'tick')
    const page = traffic.read(0)
    expect(page.entries).toHaveLength(TRAFFIC_PAGE)
    expect(page.entries.at(-1)?.seq).toBe(TRAFFIC_PAGE + 5)
    expect(page.gap).toBe(true)
  })
})
