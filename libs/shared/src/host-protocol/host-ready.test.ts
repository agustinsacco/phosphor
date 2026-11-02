import { describe, expect, it } from 'vitest'
import { parseHostFrame } from '../host-protocol'
import { parseReadyFrame } from './host-ready'

const HOST = '00000000-0000-4000-8000-000000000006'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const EPOCH = '0123456789abcdef'
const TIME = '2026-01-01T00:00:00.000Z'
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const REFUSED = { ok: false, reason: 'host-frame' }
const HELLO = {
  hostId: HOST,
  hostVersion: '2.0.0-beta.1+build',
  protocolVersion: 1,
  runtimeEpoch: EPOCH,
  capabilities: ['sessions.read', 'sessions.control', 'routines'],
}
const READY = {
  type: 'ready',
  protocolVersion: 1,
  hello: HELLO,
  proof: '_'.repeat(85) + 'A',
  connectionId: EPOCH,
  grantExpiresAt: TIME,
  client: { id: CLIENT, label: 'Phone' },
  capabilities: ['routines', 'sessions.read'],
}
const ready = (fields: object) => parseHostFrame(JSON.stringify({ ...READY, ...fields }))
const hello = (fields: object) => ready({ hello: { ...HELLO, ...fields } })

// Characterization through the public entry, before ready parsing moves to host-ready.ts.
describe('ready frames through the public entry', () => {
  it('accepts only a canonical 86-character base64url Ed25519 proof', () => {
    for (const last of BASE64URL)
      expect(ready({ proof: 'A'.repeat(85) + last }).ok, last).toBe('AQgw'.includes(last))
    for (const proof of [
      'A'.repeat(85),
      'A'.repeat(87),
      'A'.repeat(84) + '+A',
      'A'.repeat(84) + '/A',
      'A'.repeat(84) + '=A',
      1,
    ])
      expect(ready({ proof }), String(proof)).toStrictEqual(REFUSED)
  })

  it('checks the enrolled hello, refusing unknown or repeated capabilities', () => {
    expect(ready({})).toStrictEqual({ ok: true, value: READY })
    expect(hello({ x: 1 })).toStrictEqual({ ok: true, value: READY })
    expect(hello({ capabilities: [] }).ok).toBe(false)
    expect(ready({ hello: { ...HELLO, capabilities: [] }, capabilities: [] }).ok).toBe(true)
    for (const patch of [
      { hostId: 'host-1' },
      { runtimeEpoch: 'epoch' },
      { hostVersion: '' },
      { hostVersion: 'v 1' },
      { protocolVersion: 2 },
      { protocolVersion: '1' },
      { capabilities: ['sessions.read', 'sessions.read'] },
      { capabilities: ['sessions.read', 'future'] },
      { capabilities: 'sessions.read' },
    ])
      expect(hello(patch), JSON.stringify(patch)).toStrictEqual(REFUSED)
  })

  it('grants only a unique subset of the hello capabilities, in the order sent', () => {
    for (const capabilities of [
      [],
      ['routines'],
      ['sessions.control', 'sessions.read', 'routines'],
    ])
      expect(ready({ capabilities })).toStrictEqual({ ok: true, value: { ...READY, capabilities } })
    for (const capabilities of [['terminal'], ['routines', 'routines'], ['future'], null])
      expect(ready({ capabilities }), JSON.stringify(capabilities)).toStrictEqual(REFUSED)
  })

  it('checks the connection, grant expiry, client and protocol version fields', () => {
    for (const patch of [
      { protocolVersion: 2 },
      { connectionId: EPOCH.toUpperCase() },
      { grantExpiresAt: '2026-01-01T00:00:00Z' },
      { client: { id: CLIENT } },
      { client: { id: 'c', label: 'Phone' } },
      { client: { id: CLIENT, label: 'Phone\n' } },
    ])
      expect(ready(patch), JSON.stringify(patch)).toStrictEqual(REFUSED)
    expect(ready({ client: { id: CLIENT, label: 'Phone', x: 1 } })).toStrictEqual({
      ok: true,
      value: READY,
    })
  })
})

describe('host-ready.ts parseReadyFrame', () => {
  it('projects a ready record, rebuilding the hello from its validated fields', () => {
    expect(parseReadyFrame({ ...READY, x: 1, hello: { ...HELLO, x: 1 } })).toStrictEqual(READY)
    expect(parseReadyFrame({ ...READY, protocolVersion: 1.0 })).toStrictEqual(READY)
  })

  it('checks the hello against its own host id and the proof shape', () => {
    expect(parseReadyFrame({ ...READY, hello: { ...HELLO, hostId: 'host-1' } })).toBeNull()
    expect(parseReadyFrame({ ...READY, proof: 'w'.repeat(86) })).toStrictEqual({
      ...READY,
      proof: 'w'.repeat(86),
    })
    expect(parseReadyFrame({ ...READY, proof: 'w'.repeat(85) + 'x' })).toBeNull()
  })

  it('keeps connection capabilities a subset of the hello, as sent', () => {
    const hello = { ...HELLO, capabilities: ['terminal'] }
    expect(parseReadyFrame({ ...READY, hello, capabilities: ['terminal'] })).toStrictEqual({
      ...READY,
      hello,
      capabilities: ['terminal'],
    })
    expect(parseReadyFrame({ ...READY, hello, capabilities: ['routines'] })).toBeNull()
  })

  it('carries the additive machineShell marker only as a boolean', () => {
    expect(parseReadyFrame({ ...READY, machineShell: true })).toStrictEqual({
      ...READY,
      machineShell: true,
    })
    expect(parseReadyFrame({ ...READY, machineShell: 'yes' })).toBeNull()
  })
})

describe('lane marks support marker', () => {
  it('carries the additive laneMarks marker only as a boolean', () => {
    expect(parseReadyFrame({ ...READY, laneMarks: true })).toStrictEqual({
      ...READY,
      laneMarks: true,
    })
    expect(parseReadyFrame({ ...READY, laneMarks: 'yes' })).toBeNull()
    expect(ready({ laneMarks: true })).toMatchObject({ ok: true, value: { laneMarks: true } })
  })
})

describe('lane start support marker', () => {
  it('carries the additive laneStart marker only as a boolean', () => {
    expect(parseReadyFrame({ ...READY, laneStart: true })).toStrictEqual({
      ...READY,
      laneStart: true,
    })
    expect(parseReadyFrame({ ...READY, laneStart: 1 })).toBeNull()
    expect(ready({ laneStart: true })).toMatchObject({ ok: true, value: { laneStart: true } })
  })
})
