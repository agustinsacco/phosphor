import { describe, expect, it } from 'vitest'
import { parseHostFrame } from '../host-protocol'

const LANE = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const EPOCH = '0123456789abcdef'
const TIME = '2026-01-01T00:00:00.000Z'
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
  activity: 'working',
  createdAt: TIME,
  updatedAt: TIME,
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const STATE = { cursor: { epoch: EPOCH, seq: 0 }, summary: SUMMARY, state: null }
const LISTS = { messages: [], pending: [], dialogs: [], ui: [] }
const snapshot = (fields: object) =>
  host({
    type: 'snapshot',
    id: 's',
    laneId: LANE,
    reset: false,
    snapshot: { ...STATE, ...LISTS, ...fields },
  })
const event = (value: unknown, laneId = LANE) =>
  host({ type: 'event', id: 's', laneId, cursor: { epoch: EPOCH, seq: 1 }, event: value })
const request = (method: string, id = method) => ({ type: 'extension_ui_request', id, method })

// Characterization through the public entry, before snapshot and event parsing move out.
describe('lane snapshots and events through the public entry', () => {
  it('passes future pi messages, events, state and dialogs through by identity of shape', () => {
    const fields = {
      state: { future: { nested: [1] } },
      messages: [{ role: 'tool-v2', payload: { a: [null] } }],
      pending: [{ type: 'turn_v2', data: 'x' }],
      dialogs: [{ ...request('choose-many', 'd'), options: [{ deep: true }] }],
    }
    const frame = {
      type: 'snapshot',
      id: 's',
      laneId: LANE,
      reset: true,
      snapshot: { ...STATE, ...LISTS, ...fields },
    }
    expect(host(frame)).toStrictEqual({ ok: true, value: frame })
    for (const patch of [
      { state: 'x' },
      { messages: [{ role: 1 }] },
      { pending: [null] },
      { dialogs: [request('m', 'a.b')] },
    ])
      expect(snapshot(patch), JSON.stringify(patch)).toStrictEqual(REFUSED)
    for (const n of [4000, 4001])
      expect(snapshot({ pending: Array(n).fill({ type: 'x' }) }).ok).toBe(n === 4000)
  })

  it('caps UI state at 64 statuses, 32 widgets and one title, 97 in all', () => {
    const many = (method: string, n: number) =>
      Array.from({ length: n }, (_, i) => request(method, `${method}${i}`))
    expect(
      snapshot({ ui: [...many('setStatus', 64), ...many('setWidget', 32), request('setTitle')] })
        .ok,
    ).toBe(true)
    for (const ui of [
      many('setStatus', 65),
      many('setWidget', 33),
      many('setTitle', 2),
      [request('notify')],
      [request('setStatus', '')],
    ])
      expect(snapshot({ ui })).toStrictEqual(REFUSED)
  })

  it('keeps a snapshot and a summary event on the frame lane', () => {
    expect(snapshot({}).ok).toBe(true)
    expect(snapshot({ summary: { ...SUMMARY, laneId: OTHER } })).toStrictEqual(REFUSED)
    expect(event({ kind: 'summary', summary: SUMMARY }).ok).toBe(true)
    expect(event({ kind: 'summary', summary: SUMMARY }, OTHER)).toStrictEqual(REFUSED)
    expect(event({ kind: 'control', control: { fence: 3, controller: null } }, OTHER).ok).toBe(true)
    expect(event({ kind: 'dialog-resolved', dialogId: 'd' }, OTHER).ok).toBe(true)
  })

  it('forwards event, extension-ui and exit pushes, never stderr or resync', () => {
    const exit = { kind: 'exit', code: 0, signal: null, expected: true }
    for (const push of [
      { kind: 'event', event: { type: 'future', x: [1] } },
      { kind: 'extension-ui', request: { ...request('confirm', 'd'), title: 't' } },
      exit,
      { ...exit, code: null, signal: 'SIGKILL' },
    ])
      expect(event({ kind: 'pi', push: { ...push, x: 1 } })).toStrictEqual({
        ok: true,
        value: {
          type: 'event',
          id: 's',
          laneId: LANE,
          cursor: { epoch: EPOCH, seq: 1 },
          event: { kind: 'pi', push },
        },
      })
    for (const push of [
      { kind: 'stderr', text: 'secret' },
      { kind: 'resync' },
      { ...exit, code: 1.5 },
      { ...exit, signal: 'S'.repeat(65) },
      { ...exit, expected: undefined },
      { kind: 'extension-ui', request: { type: 'extension_ui_request', id: 'd' } },
    ])
      expect(event({ kind: 'pi', push }), JSON.stringify(push)).toStrictEqual(REFUSED)
  })
})
