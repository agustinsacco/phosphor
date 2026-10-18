import { describe, expect, it } from 'vitest'
import {
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  parseHostSelfResponse,
  parseMachineRenameRequest,
  parseMachineView,
  parseMachinesResponse,
  parseMeResponse,
  type Parsed,
} from '../control-api'

const ID = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const TIME = '2026-10-12T10:00:00.000Z'
const NOT_OBJECTS = [null, undefined, [], 'body', 7]
const machine = {
  id: ID,
  label: 'bee1',
  hostname: 'bee1',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '0.2.0',
  keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
  enrolledAt: TIME,
  lastSeenAt: TIME,
  state: 'running',
  readiness: { pi: 'ok', claude: 'signed-out', tailscale: 'ok' },
  lanes: { running: 2, waiting: 1 },
  endpoint: 'https://bee1.ts.net',
}
const beat = {
  seq: 7,
  state: 'running',
  hostVersion: '0.2.0',
  uptimeSec: 120,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'no-https' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}

/** The reason a parser gives while each bad field, in turn, is the first one left. */
function failureOrder(
  parse: (value: unknown) => Parsed<unknown>,
  valid: Record<string, unknown>,
  bad: Record<string, unknown>,
): string[] {
  const fields = Object.keys(bad)
  return fields.map((_, index) => {
    const body: Record<string, unknown> = { ...valid }
    for (const field of fields.slice(index)) body[field] = bad[field]
    const parsed = parse(body)
    return parsed.ok ? 'ok' : parsed.reason
  })
}

const without = (value: Record<string, unknown>, field: string) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))

describe('machine parsers through the control-api entry', () => {
  it('checks machine fields in wire order', () => {
    expect(
      failureOrder(parseMachineView, machine, {
        id: 'x',
        label: ' bee1 ',
        hostname: '',
        platform: 'aix',
        arch: 'mips',
        hostVersion: 'x',
        keyFingerprint: '',
        enrolledAt: null,
        lastSeenAt: 'x',
        state: 'paused',
        readiness: { pi: 'ok' },
        lanes: { running: -1, waiting: 0 },
        endpoint: 'http://bee1.ts.net',
      }),
    ).toEqual(Object.keys(machine))
    for (const value of NOT_OBJECTS)
      expect(parseMachineView(value)).toStrictEqual({
        ok: false,
        reason: 'machine must be an object',
      })
  })

  it('takes null but not a missing value for each nullable machine field', () => {
    const nullable = ['hostVersion', 'lastSeenAt', 'state', 'readiness', 'lanes', 'endpoint']
    for (const field of nullable) {
      const parsed = parseMachineView({ ...machine, [field]: null })
      expect(parsed.ok && parsed.value[field as keyof typeof machine]).toBeNull()
      expect(parseMachineView(without(machine, field))).toStrictEqual({ ok: false, reason: field })
    }
    for (const field of ['label', 'hostname', 'enrolledAt'])
      expect(parseMachineView({ ...machine, [field]: null })).toStrictEqual({
        ok: false,
        reason: field,
      })
    expect(parseMachineView({ ...machine, state: 'stopping' }).ok).toBe(true)
  })

  it('bounds the machine list at 100 and names the first bad machine', () => {
    const list = (count: number) => ({ machines: Array(count).fill(machine), serverTime: TIME })
    expect(parseMachinesResponse(list(0))).toStrictEqual({ ok: true, value: list(0) })
    expect(parseMachinesResponse(list(100)).ok).toBe(true)
    expect(parseMachinesResponse(list(101))).toStrictEqual({ ok: false, reason: 'machines' })
    expect(parseMachinesResponse({ ...list(101), serverTime: 'x' })).toStrictEqual({
      ok: false,
      reason: 'serverTime',
    })
    const bad = { machines: [machine, { ...machine, arch: 'x' }, { id: 'x' }], serverTime: TIME }
    expect(parseMachinesResponse(bad)).toStrictEqual({ ok: false, reason: 'machines: arch' })
    for (const value of [...NOT_OBJECTS, {}, { machines: {}, serverTime: TIME }])
      expect(parseMachinesResponse(value)).toStrictEqual({ ok: false, reason: 'machines' })
  })

  it('reads me and rename bodies with their own bounds', () => {
    const me = { account: { login: null }, enabled: true, maxHosts: 10_000 }
    expect(parseMeResponse(me)).toStrictEqual({ ok: true, value: me })
    expect(
      failureOrder(parseMeResponse, me, { account: {}, enabled: 1, maxHosts: 10_001 }),
    ).toEqual(['account', 'enabled', 'maxHosts'])
    expect(parseMeResponse(null)).toStrictEqual({ ok: false, reason: 'body must be an object' })
    expect(parseMachineRenameRequest({ label: ' bee ' })).toStrictEqual({
      ok: true,
      value: { label: 'bee' },
    })
    for (const value of [...NOT_OBJECTS, {}, { label: '\u202ebee' }])
      expect(parseMachineRenameRequest(value)).toStrictEqual({ ok: false, reason: 'label' })
  })

  it('checks a Host self record in order, with a null but present last beat', () => {
    const self = {
      hostId: ID,
      label: 'bee1',
      owner: { login: 'octo' },
      enrolledAt: TIME,
      lastSeenAt: null,
    }
    expect(parseHostSelfResponse(self)).toStrictEqual({ ok: true, value: self })
    expect(
      failureOrder(parseHostSelfResponse, self, {
        hostId: 'x',
        label: '',
        owner: null,
        enrolledAt: 'x',
        lastSeenAt: undefined,
      }),
    ).toEqual(['hostId', 'label', 'owner', 'enrolledAt', 'lastSeenAt'])
    expect(parseHostSelfResponse(7)).toStrictEqual({ ok: false, reason: 'body must be an object' })
  })

  it('checks heartbeat fields in order and bounds sequence and uptime', () => {
    expect(
      failureOrder(parseHeartbeatRequest, beat, {
        seq: 0,
        state: null,
        hostVersion: '',
        uptimeSec: -1,
        readiness: null,
        lanes: null,
        endpoint: undefined,
      }),
    ).toEqual(Object.keys(beat))
    for (const seq of [1, Number.MAX_SAFE_INTEGER])
      expect(parseHeartbeatRequest({ ...beat, seq }).ok).toBe(true)
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7'])
      expect(parseHeartbeatRequest({ ...beat, seq })).toStrictEqual({ ok: false, reason: 'seq' })
    expect(parseHeartbeatRequest({ ...beat, uptimeSec: 316_224_000 }).ok).toBe(true)
    expect(parseHeartbeatRequest({ ...beat, uptimeSec: 316_224_001 })).toStrictEqual({
      ok: false,
      reason: 'uptimeSec',
    })
    expect(parseHeartbeatRequest({ ...beat, endpoint: 'https://bee1.ts.net' }).ok).toBe(true)
    expect(parseHeartbeatRequest([])).toStrictEqual({ ok: false, reason: 'body must be an object' })
  })

  it('treats heartbeat reply metadata as omissible but never null', () => {
    const base = { accepted: true, nextInSec: 30 }
    const revoked = { sessions: [], clients: [ID] }
    expect(
      failureOrder(
        parseHeartbeatResponse,
        { ...base, epoch: 1, ownerId: ID, revoked },
        { nextInSec: 9, epoch: null, ownerId: null, revoked: null },
      ),
    ).toEqual(['nextInSec', 'epoch', 'ownerId', 'revoked'])
    for (const nextInSec of [10, 3600])
      expect(parseHeartbeatResponse({ ...base, nextInSec })).toStrictEqual({
        ok: true,
        value: { accepted: true, nextInSec },
      })
    expect(parseHeartbeatResponse({ ...base, nextInSec: 3601 }).ok).toBe(false)
    for (const epoch of [1, 2_147_483_647])
      expect(parseHeartbeatResponse({ ...base, epoch })).toStrictEqual({
        ok: true,
        value: { ...base, epoch },
      })
    expect(parseHeartbeatResponse({ ...base, revoked })).toStrictEqual({
      ok: true,
      value: { ...base, revoked },
    })
    for (const value of [...NOT_OBJECTS, {}, { ...base, accepted: 'true' }])
      expect(parseHeartbeatResponse(value)).toStrictEqual({ ok: false, reason: 'accepted' })
  })
})
