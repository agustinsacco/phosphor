import { describe, expect, it } from 'vitest'
import { parseHostFrame } from '../host-protocol'

const LANE = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const EPOCH = '0123456789abcdef'
const REPO = 'fedcba9876543210'
const TIME = '2026-01-01T00:00:00.000Z'
const REFUSED = { ok: false, reason: 'host-frame' }
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
const CONTROL = { fence: 1, controller: { clientId: CLIENT, label: 'Desktop', connected: true } }
const SUMMARY = {
  laneId: LANE,
  repositoryId: REPO,
  cwd: '/repo',
  title: 'Lane',
  branch: 'main',
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: TIME,
  updatedAt: TIME,
  attention: 0,
  read: 0,
  control: CONTROL,
}
const lanes = (fields: object) =>
  host({
    type: 'lanes',
    id: 'lanes',
    cursor: { epoch: EPOCH, seq: 0 },
    repositories: [],
    lanes: [],
    ...fields,
  })
const delta = (fields: object) =>
  host({
    type: 'lanes-delta',
    id: 'lanes',
    cursor: { epoch: EPOCH, seq: 1 },
    upsert: [],
    remove: [],
    ...fields,
  })
const summaryOk = (summary: object) => lanes({ lanes: [summary] }).ok

// Characterization through the public entry, before lane frame parsing moves to host-lanes.ts.
describe('lane list frames through the public entry', () => {
  it('requires a positive safe-integer fence and a whole or null controller', () => {
    for (const control of [
      { fence: 1, controller: null },
      { fence: Number.MAX_SAFE_INTEGER, controller: CONTROL.controller },
      { ...CONTROL, controller: { ...CONTROL.controller, connected: false } },
    ])
      expect(summaryOk({ ...SUMMARY, control }), JSON.stringify(control)).toBe(true)
    for (const control of [
      { fence: 0, controller: null },
      { fence: 1.5, controller: null },
      { fence: 1 },
      { fence: 1, controller: { clientId: CLIENT, label: 'Desktop' } },
      { fence: 1, controller: { ...CONTROL.controller, label: ' Desktop' } },
      { fence: 1, controller: { ...CONTROL.controller, clientId: 'c' } },
    ])
      expect(summaryOk({ ...SUMMARY, control }), JSON.stringify(control)).toBe(false)
  })

  it('keeps read at or below attention and checks each summary field', () => {
    for (const [attention, read] of [
      [0, 0],
      [5, 5],
      [5, 0],
    ])
      expect(summaryOk({ ...SUMMARY, attention, read })).toBe(true)
    for (const [attention, read] of [
      [0, 1],
      [5, 6],
      [-1, -1],
    ])
      expect(summaryOk({ ...SUMMARY, attention, read })).toBe(false)
    for (const patch of [{ title: null, branch: null }, { model: { provider: 'p', id: 'i' } }])
      expect(summaryOk({ ...SUMMARY, ...patch })).toBe(true)
    for (const patch of [
      { cwd: '' },
      { branch: 'a b' },
      { activity: 'busy' },
      { model: { id: 'i' } },
      { updatedAt: '2026' },
    ])
      expect(summaryOk({ ...SUMMARY, ...patch }), JSON.stringify(patch)).toBe(false)
  })

  it('caps repositories, lanes, upserts and removals', () => {
    const repository = { id: REPO, name: 'r', path: '/r' }
    for (const n of [64, 65])
      expect(lanes({ repositories: Array(n).fill(repository) }).ok).toBe(n === 64)
    for (const n of [1000, 1001])
      expect(lanes({ lanes: Array(n).fill(SUMMARY) }).ok).toBe(n === 1000)
    for (const n of [1000, 1001])
      expect(delta({ upsert: Array(n).fill(SUMMARY) }).ok).toBe(n === 1000)
    for (const n of [1000, 1001]) expect(delta({ remove: Array(n).fill(LANE) }).ok).toBe(n === 1000)
    for (const repositories of [[{ ...repository, name: '' }], [{ ...repository, id: 'x' }], null])
      expect(lanes({ repositories })).toStrictEqual(REFUSED)
  })

  it('takes a lanes cursor from seq 0 but delta, routines and attention cursors from seq 1', () => {
    expect(lanes({ cursor: { epoch: EPOCH, seq: 0 } }).ok).toBe(true)
    expect(delta({ cursor: { epoch: EPOCH, seq: 0 } })).toStrictEqual(REFUSED)
    const routines = { type: 'routines-changed', id: 'r', cursor: { epoch: EPOCH, seq: 1 } }
    expect(host(routines)).toStrictEqual({ ok: true, value: routines })
    expect(host({ ...routines, cursor: { epoch: EPOCH, seq: 0 } })).toStrictEqual(REFUSED)
    expect(host({ ...routines, cursor: { ...routines.cursor, x: 1 } })).toStrictEqual({
      ok: true,
      value: routines,
    })
  })

  it('identifies an attention event by lane and counter, and projects it', () => {
    const event = {
      id: `${LANE}:4`,
      laneId: LANE,
      kind: 'routine-paused',
      attention: 4,
      at: TIME,
      title: null,
    }
    const frame = { type: 'attention', id: 'lanes', cursor: { epoch: EPOCH, seq: 1 }, event }
    expect(host({ ...frame, event: { ...event, x: 1 } })).toStrictEqual({ ok: true, value: frame })
    for (const patch of [
      { id: `${LANE}:5` },
      { id: `${LANE}:04` },
      { id: LANE },
      { attention: 0, id: `${LANE}:0` },
      { kind: 'started' },
      { title: '' },
      { at: 'now' },
    ])
      expect(
        host({ ...frame, event: { ...event, ...patch } }),
        JSON.stringify(patch),
      ).toStrictEqual(REFUSED)
  })
})
