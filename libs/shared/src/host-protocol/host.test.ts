import { describe, expect, it } from 'vitest'
import { parseHostFrame, type HostFrame } from '../host-protocol'
import * as facade from '../host-protocol'
import { parseHostFrame as parseHostLeaf } from './host'

const LANE = '00000000-0000-4000-8000-000000000001'
const REQUEST = '00000000-0000-4000-8000-000000000003'
const TERM = '00000000-0000-4000-8000-000000000004'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const EPOCH = '0123456789abcdef'
const TIME = '2026-01-01T00:00:00.000Z'
const CURSOR = { epoch: EPOCH, seq: 1 }
const REFUSED = { ok: false, reason: 'host-frame' }
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
const SUMMARY = {
  laneId: LANE,
  repositoryId: 'fedcba9876543210',
  cwd: '/repo',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'stopped',
  createdAt: TIME,
  updatedAt: TIME,
  attention: 1,
  read: 1,
  control: { fence: 1, controller: null },
} as const
const TERMINAL = { id: 't', terminalId: TERM, epoch: EPOCH, seq: 1 }
const HELLO = { hostId: LANE, hostVersion: '1', protocolVersion: 1, runtimeEpoch: EPOCH } as const

/** One canonical frame per Host frame type; tsc fails here when HostFrame gains a type. */
const FRAMES = {
  'terminal.ack': { type: 'terminal.ack', terminalId: TERM, seq: 1, accepted: true },
  'terminal.output': { type: 'terminal.output', ...TERMINAL, data: 'x' },
  'terminal.reset': {
    type: 'terminal.reset',
    ...TERMINAL,
    data: 'x',
    inputSeq: 0,
    status: 'running',
  },
  'terminal.exit': { type: 'terminal.exit', ...TERMINAL, exitCode: 0 },
  ready: {
    type: 'ready',
    protocolVersion: 1,
    hello: { ...HELLO, capabilities: ['sessions.read'] },
    proof: 'Q'.repeat(86),
    connectionId: EPOCH,
    grantExpiresAt: TIME,
    client: { id: CLIENT, label: 'Desktop' },
    capabilities: ['sessions.read'],
  },
  'auth-renewed': { type: 'auth-renewed', grantExpiresAt: TIME },
  lanes: { type: 'lanes', id: 'l', cursor: CURSOR, repositories: [], lanes: [SUMMARY] },
  'lanes-delta': { type: 'lanes-delta', id: 'l', cursor: CURSOR, upsert: [], remove: [LANE] },
  'routines-changed': { type: 'routines-changed', id: 'r', cursor: CURSOR },
  attention: {
    type: 'attention',
    id: 'l',
    cursor: CURSOR,
    event: { id: `${LANE}:1`, laneId: LANE, kind: 'failed', attention: 1, at: TIME, title: null },
  },
  snapshot: {
    type: 'snapshot',
    id: 's',
    laneId: LANE,
    reset: false,
    snapshot: {
      cursor: CURSOR,
      summary: SUMMARY,
      state: null,
      messages: [],
      pending: [],
      dialogs: [],
      ui: [],
    },
  },
  event: {
    type: 'event',
    id: 's',
    laneId: LANE,
    cursor: CURSOR,
    event: { kind: 'dialog-resolved', dialogId: 'd' },
  },
  'subscribe-failed': { type: 'subscribe-failed', id: 's', code: 'forbidden' },
  receipt: { type: 'receipt', receipt: { requestId: REQUEST, status: 'pending' } },
  result: { type: 'result', id: 'c', ok: true, data: 1 },
  error: { type: 'error', code: 4403, message: 'forbidden' },
  pong: { type: 'pong', at: 1 },
} satisfies { readonly [T in HostFrame['type']]: Extract<HostFrame, { type: T }> }
const EXACT_KEYS = /^(terminal\.|routines-changed$)/
const rows = Object.values(FRAMES).map((frame) => ({ type: frame.type, frame }))
const deep = '['.repeat(50_000) + ']'.repeat(50_000)
/** Values no top-level Host frame field accepts, except a result's free-form data. */
const HOSTILE = ['null', '{}', '-1.5', deep]

// Characterization through the public entry, before parseHostFrame moves to host.ts.
describe('parseHostFrame dispatch through the public entry', () => {
  it.each(rows)('routes $type to its parser and returns it unchanged', ({ frame }) => {
    expect(host(frame)).toStrictEqual({ ok: true, value: frame })
  })

  it.each(rows)(
    'refuses $type with exactly the host-frame reason when a field is hostile',
    ({ frame }) => {
      for (const key of Object.keys(frame).filter((k) => k !== 'type')) {
        const rest = Object.fromEntries(Object.entries(frame).filter(([k]) => k !== key))
        expect(host(rest), `${frame.type} without ${key}`).toStrictEqual(REFUSED)
        for (const value of HOSTILE) {
          const text = JSON.stringify({ ...frame, [key]: '@hostile' }).replace('"@hostile"', value)
          const label = `${frame.type}.${key} = ${value.slice(0, 8)}`
          // A result's data is free-form; deep values are checked by acceptance only.
          if (frame.type === 'result' && key === 'data')
            expect(parseHostFrame(text).ok, label).toBe(true)
          else expect(parseHostFrame(text), label).toStrictEqual(REFUSED)
        }
      }
    },
  )

  it.each(rows)(
    '$type: own __proto__ and constructor keys never reach the projection',
    ({ frame }) => {
      const text =
        '{"__proto__":{"polluted":true},"constructor":1,' + JSON.stringify(frame).slice(1)
      expect(parseHostFrame(text)).toStrictEqual(
        EXACT_KEYS.test(frame.type) ? REFUSED : { ok: true, value: frame },
      )
      expect(Object.prototype).not.toHaveProperty('polluted')
    },
  )

  it('refuses unknown, client-only and non-string types, and passes read failures through', () => {
    for (const type of [
      'terminal.input',
      'terminal.',
      'ping',
      'auth',
      'command',
      'Pong',
      1,
      null,
      undefined,
    ])
      expect(host({ type, at: 1, terminalId: TERM, seq: 1 }), String(type)).toStrictEqual(REFUSED)
    expect(parseHostFrame('{"type":"pong"')).toStrictEqual({ ok: false, reason: 'json' })
    expect(parseHostFrame('"pong"')).toStrictEqual({ ok: false, reason: 'object' })
    expect(parseHostFrame(' '.repeat(16 * 1024 * 1024 + 1))).toStrictEqual({
      ok: false,
      reason: 'frame-size',
    })
  })

  it('maps an error frame code onto its close code and refuses any other number', () => {
    for (const code of [1001, 4400, 4401, 4403, 4409, 4429])
      expect(host({ type: 'error', code, message: 'm' })).toStrictEqual({
        ok: true,
        value: { type: 'error', code, message: 'm' },
      })
    for (const code of [1000, 4402, 4400.5, '4400', -4400])
      expect(host({ type: 'error', code, message: 'm' }), String(code)).toStrictEqual(REFUSED)
  })
})

describe('host.ts parseHostFrame', () => {
  it('is the parser the public entry exports', () => {
    expect(facade.parseHostFrame).toBe(parseHostLeaf)
  })

  it('dispatches every frame type and refuses with one exact envelope', () => {
    for (const { type, frame } of rows) {
      expect(parseHostLeaf(JSON.stringify(frame)), type).toStrictEqual({ ok: true, value: frame })
      const [first] = Object.keys(frame).filter((key) => key !== 'type')
      const missing = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== first))
      expect(parseHostLeaf(JSON.stringify(missing)), `${type} without ${first}`).toStrictEqual(
        REFUSED,
      )
    }
    expect(parseHostLeaf('[')).toStrictEqual({ ok: false, reason: 'json' })
  })
})
