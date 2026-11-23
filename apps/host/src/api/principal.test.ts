import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import { HOST_CAPABILITIES, type HostHello } from '@phosphor/shared/remote-host'
import { createAuthority } from './authority'
import { createConfigurationAuthority } from './configuration-authority'
import { createGrantAuth, type AuthOutcome } from './grant-auth'
import {
  LOCAL_CAPABILITIES,
  grantConnectionPrincipal,
  laneCommandOrigin,
  opPrincipalFor,
  principalCapabilities,
  type ConnectionPrincipal,
} from './principal'

const hello: HostHello = {
  hostId: randomUUID(),
  hostVersion: 'test',
  protocolVersion: 1,
  runtimeEpoch: '0123456789abcdef',
  capabilities: [...HOST_CAPABILITIES],
}
const client = { id: randomUUID(), label: 'Laptop' }
const machineId = randomUUID()
const user: ConnectionPrincipal = { kind: 'grant-user', clientId: client.id }
const machine: ConnectionPrincipal = { kind: 'grant-machine', clientId: client.id, machineId }
const owner: ConnectionPrincipal = { kind: 'owner', clientId: client.id }
const local: ConnectionPrincipal = { kind: 'local', clientId: client.id, lane: 'session-1' }

describe('connection principals', () => {
  it('gives grants their granted caps, the owner everything and local readers reads only', () => {
    expect(principalCapabilities(hello, user, { caps: ['sessions.read'] })).toEqual([
      'sessions.read',
    ])
    expect(
      principalCapabilities(hello, user, { caps: ['sessions.read'], configure: true }),
    ).toEqual(['sessions.read', 'machine.configure'])
    expect(principalCapabilities(hello, machine, { caps: [] })).toEqual([])
    expect(principalCapabilities(hello, user)).toEqual([])
    expect(principalCapabilities(hello, owner)).toEqual(HOST_CAPABILITIES)
    expect(principalCapabilities(hello, local)).toEqual(LOCAL_CAPABILITIES)
    expect(
      principalCapabilities({ ...hello, capabilities: ['sessions.read', 'terminal'] }, local),
    ).toEqual(['sessions.read'])
  })

  it('maps each connection to the op principal its ops.run runs as', () => {
    const actor = { kind: 'agent', lane: 'host:x/lane:y' } as const
    expect(opPrincipalFor(user, client, actor)).toEqual({
      kind: 'surface',
      clientId: client.id,
      label: 'Laptop',
      via: 'grant',
    })
    expect(opPrincipalFor(owner, client)).toEqual({
      kind: 'surface',
      clientId: client.id,
      label: 'Laptop',
      via: 'owner',
    })
    expect(opPrincipalFor(machine, client, actor)).toEqual({
      kind: 'machine',
      machineId,
      clientId: client.id,
      label: 'Laptop',
      lane: 'host:x/lane:y',
    })
    expect(opPrincipalFor(machine, client)).toMatchObject({ lane: null })
    expect(opPrincipalFor(local, client)).toEqual({
      kind: 'local',
      clientId: client.id,
      lane: 'session-1',
    })
    expect(opPrincipalFor({ kind: 'local', clientId: client.id }, client)).toEqual({
      kind: 'local',
      clientId: client.id,
    })
  })

  it('leaves a user grant without a lane command origin', () => {
    expect(laneCommandOrigin(undefined)).toBeUndefined()
    expect(laneCommandOrigin(user)).toBeUndefined()
    expect(laneCommandOrigin(owner)).toBe('surface')
    expect(laneCommandOrigin(machine)).toBe('machine')
    expect(laneCommandOrigin(local)).toBe('local')
  })

  it('stamps a lane command sender with its origin only when there is one', () => {
    const authority = createConfigurationAuthority({
      caps: () => ['sessions.control'],
      closed: () => false,
      open: () => true,
    })
    expect(authority.sender(client, 'c1')).not.toHaveProperty('origin')
    expect(authority.sender(client, 'c1', laneCommandOrigin(local))).toMatchObject({
      id: client.id,
      origin: 'local',
    })
  })

  it('names a grant connection by the grant principal', () => {
    expect(grantConnectionPrincipal({ kind: 'user', clientId: 'c', label: 'L' })).toEqual({
      kind: 'grant-user',
      clientId: 'c',
    })
    expect(
      grantConnectionPrincipal({ kind: 'machine', machineId, clientId: 'c', label: 'L' }),
    ).toEqual({ kind: 'grant-machine', clientId: 'c', machineId })
  })

  it('accepts a user grant as a grant-user connection', async () => {
    const control = generateKeyPairSync('ed25519')
    const iat = Math.floor(Date.now() / 1000)
    const claims: GrantPayload = {
      v: 1,
      iss: 'http://localhost:12345',
      kid: 'test-key',
      sub: randomUUID(),
      sid: randomUUID(),
      hostId: hello.hostId,
      epoch: 1,
      client,
      caps: ['sessions.read'],
      iat,
      exp: iat + 300,
      jti: randomBytes(8).toString('hex'),
    }
    const authority = createAuthority()
    authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: 1 })
    const auth = createGrantAuth({
      authority,
      keyset: { get: async () => control.publicKey },
      origin: claims.iss,
      hello,
      key: generateKeyPairSync('ed25519').privateKey,
    })
    const accept = vi.fn<AuthOutcome['accept']>()
    const token = encodeGrant(claims, (bytes) => sign(null, bytes, control.privateKey))
    await auth.verify(token, 'a'.repeat(64), {
      ended: () => false,
      refuse: vi.fn(),
      admit: () => true,
      accept,
    })
    expect(accept.mock.calls[0]?.[0].principal).toEqual(user)
  })
})
