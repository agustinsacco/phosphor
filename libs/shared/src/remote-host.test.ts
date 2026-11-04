import { describe, expect, it } from 'vitest'
import {
  HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  hostResourceKey,
  remoteLaneKey,
  validateHostHello,
  type HostTarget,
} from './remote-host'

const hello = () => ({
  hostId: 'host-123',
  hostVersion: '0.1.0',
  protocolVersion: HOST_PROTOCOL_VERSION,
  runtimeEpoch: 'boot-456',
  capabilities: ['sessions.read', 'sessions.control', 'artifacts.read', 'skills.read'],
})

const invalid = { ok: false, reason: 'invalid-handshake' }

describe('validateHostHello', () => {
  it('accepts a compatible, enrolled host without requiring every capability', () => {
    expect(validateHostHello(hello(), 'host-123')).toEqual({ ok: true, hello: hello() })
    expect(validateHostHello({ ...hello(), capabilities: [] }, 'host-123')).toEqual({
      ok: true,
      hello: { ...hello(), capabilities: [] },
    })
  })

  it('understands every declared capability', () => {
    const value = { ...hello(), capabilities: [...HOST_CAPABILITIES] }
    expect(validateHostHello(value, 'host-123')).toEqual({ ok: true, hello: value })
  })

  it('ignores additive fields and capabilities without enabling unknown features', () => {
    const value = {
      ...hello(),
      extra: { secret: 'must not reach the result' },
      capabilities: ['sessions.read', 'future.feature', 'sessions.read'],
    }
    expect(validateHostHello(value, 'host-123')).toEqual({
      ok: true,
      hello: { ...hello(), capabilities: ['sessions.read'] },
    })
    expect(value.capabilities).toEqual(['sessions.read', 'future.feature', 'sessions.read'])
  })

  it('rejects a different host even when its protocol is compatible', () => {
    expect(validateHostHello(hello(), 'another-host')).toEqual({
      ok: false,
      reason: 'host-mismatch',
    })
  })

  it('rejects unsupported protocols rather than guessing compatibility', () => {
    expect(validateHostHello({ ...hello(), protocolVersion: 2 }, 'host-123')).toEqual({
      ok: false,
      reason: 'unsupported-protocol',
    })
  })

  it.each([null, undefined, false, [], 'host', 42])('rejects a non-object: %j', (value) => {
    expect(validateHostHello(value, 'host-123')).toEqual(invalid)
  })

  it.each(['hostId', 'hostVersion', 'protocolVersion', 'runtimeEpoch', 'capabilities'])(
    'requires %s',
    (field) => {
      const value: Record<string, unknown> = hello()
      delete value[field]
      expect(validateHostHello(value, 'host-123')).toEqual(invalid)
    },
  )

  it.each([
    { hostId: '' },
    { hostId: '../host' },
    { hostId: 'a'.repeat(129) },
    { hostId: 'host-123\n' },
    { runtimeEpoch: null },
    { runtimeEpoch: 'boot 456' },
    { hostVersion: '' },
    { hostVersion: '0.1.0\n' },
    { hostVersion: 'a'.repeat(129) },
    { protocolVersion: '1' },
    { protocolVersion: 0 },
    { protocolVersion: -1 },
    { protocolVersion: 1.5 },
    { protocolVersion: Number.MAX_SAFE_INTEGER + 1 },
    { protocolVersion: Infinity },
    { capabilities: {} },
    { capabilities: [true] },
    { capabilities: [''] },
    { capabilities: ['sessions.read\n'] },
    { capabilities: ['a'.repeat(129)] },
    { capabilities: Array(65).fill('sessions.read') },
  ])('rejects malformed or unbounded fields: %j', (patch) => {
    expect(validateHostHello({ ...hello(), ...patch }, 'host-123')).toEqual(invalid)
  })

  it('requires a valid expected identity and returns no untrusted values on failure', () => {
    expect(validateHostHello(hello(), '')).toEqual(invalid)
    expect(validateHostHello({ ...hello(), hostId: 'secret/invalid' }, 'host-123')).toEqual(invalid)
  })

  it('returns a fresh projection and accepts independently versioned daemon releases', () => {
    const value = { ...hello(), hostVersion: '1.2.3-beta.1+build.9' }
    const result = validateHostHello(value, 'host-123')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected valid hello')
    result.hello.capabilities.push('terminal')
    expect(value.capabilities).not.toContain('terminal')
  })
})

describe('hostResourceKey', () => {
  const local: HostTarget = { kind: 'local' }
  const remote: HostTarget = { kind: 'remote', hostId: 'host-123' }

  it('isolates local and remote resources, hosts, and resource kinds', () => {
    const keys = [
      hostResourceKey(local, 'session', 'same-id'),
      hostResourceKey(remote, 'session', 'same-id'),
      hostResourceKey({ kind: 'remote', hostId: 'host-456' }, 'session', 'same-id'),
      hostResourceKey(remote, 'workspace', 'same-id'),
      hostResourceKey({ kind: 'remote', hostId: 'local' }, 'session', 'same-id'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is stable and preserves opaque IDs without client-side path normalization', () => {
    const path = 'C:\\repo\\Mixed Case/../file:with|delimiters'
    const key = hostResourceKey(remote, 'workspace', path)
    expect(key).toBe(hostResourceKey(remote, 'workspace', path))
    expect(JSON.parse(key)).toEqual(['remote', 'host-123', 'workspace', path])
    expect(JSON.parse(hostResourceKey(local, 'session', 'lane'))).toEqual([
      'local',
      null,
      'session',
      'lane',
    ])
  })

  it('does not collide when host and resource IDs contain delimiters', () => {
    expect(hostResourceKey({ kind: 'remote', hostId: 'a:b' }, 'session', 'c')).not.toBe(
      hostResourceKey({ kind: 'remote', hostId: 'a' }, 'session', 'b:c'),
    )
  })

  it.each(['', 'host/name', 'a'.repeat(129)])('rejects invalid host IDs: %s', (hostId) => {
    expect(() => hostResourceKey({ kind: 'remote', hostId }, 'session', 'id')).toThrow(
      'Invalid host ID',
    )
  })

  it.each(['', 'a'.repeat(4097)])('rejects empty or oversized resource IDs', (id) => {
    expect(() => hostResourceKey(remote, 'session', id)).toThrow('Invalid resource ID')
  })
})

describe('remoteLaneKey', () => {
  it('spells a Host lane as host:<hostId>/lane:<laneId>', () => {
    expect(remoteLaneKey('h-1', 'lane-7')).toBe('host:h-1/lane:lane-7')
  })
})
