import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeGrant } from '@phosphor/shared/host-grant'
import { LOCAL_CREDENTIAL_PREFIX, LOCAL_LIMITS } from '@phosphor/shared/host-local'
import { encodeBase64url, grantUtf8 } from '@phosphor/shared/host-grant'
import type { HostHello } from '@phosphor/shared/remote-host'
import { localCredential, localKeyPair } from '../owner/__fixtures__/local-identity'
import { createAuthority } from './authority'
import { fixtureGrantAuth } from './__fixtures__/grant-auth'
import type { Authentication, AuthOutcome } from './grant-auth'
import { createLocalAuth, createLocalNonces, type LocalAuthPorts } from './local-auth'
import { LOCAL_CAPABILITIES } from './principal'

const machineId = randomUUID()
const hello: HostHello = {
  hostId: machineId,
  hostVersion: '1.0.0',
  protocolVersion: 1,
  runtimeEpoch: '0123456789abcdef',
  capabilities: ['sessions.read', 'sessions.control', 'terminal', 'routines', 'machine.configure'],
}

function setup(clock = { now: 1_000_000_000_000 }) {
  const owner = localKeyPair()
  const ownerClient = { id: randomUUID(), label: 'Desktop' }
  const nonces = createLocalNonces(() => clock.now)
  const ports: LocalAuthPorts = {
    machineId,
    hello: () => hello,
    key: generateKeyPairSync('ed25519').privateKey,
    nonces,
    ownerClients: () => ({
      version: 1,
      clients: [{ ...ownerClient, publicKey: owner.raw, addedAt: '2026-01-01T00:00:00.000Z' }],
    }),
    now: () => clock.now,
  }
  const iat = () => Math.floor(clock.now / 1000)
  return { owner, ownerClient, nonces, ports, clock, iat }
}

/** One auth attempt's outcome: accepted, or refused with a close code and reason. */
async function attempt(
  auth: ReturnType<typeof createLocalAuth>,
  token: string,
  /** Null renews: a renewal carries no challenge. */
  challenge: string | null = 'c'.repeat(64),
  admit = true,
) {
  let result: { accepted: Authentication } | { refused: [number, string] } | undefined
  const outcome: AuthOutcome = {
    ended: () => false,
    refuse: (code, reason) => (result = { refused: [code, reason] }),
    admit: () => admit,
    accept: (authentication) => (result = { accepted: authentication }),
  }
  await auth.verify(token, challenge ?? undefined, outcome)
  if (!result) throw new Error('no outcome')
  return result
}

describe('local nonces', () => {
  it('are single use, expire after 60 s and are bounded at 64 outstanding', () => {
    const clock = { now: 0 }
    const nonces = createLocalNonces(() => clock.now)
    const first = nonces.issue()!
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(nonces.consume(first)).toBe(true)
    expect(nonces.consume(first)).toBe(false)
    const late = nonces.issue()!
    clock.now += LOCAL_LIMITS.nonceTtlMs
    expect(nonces.consume(late)).toBe(false)
    expect(nonces.consume('f'.repeat(64))).toBe(false)
    const held = Array.from({ length: LOCAL_LIMITS.noncesOutstanding }, () => nonces.issue())
    expect(held.every((n) => n !== null)).toBe(true)
    expect(nonces.issue()).toBeNull()
    clock.now += LOCAL_LIMITS.nonceTtlMs
    expect(nonces.issue()).not.toBeNull()
  })
})

describe('local socket authentication', () => {
  it('admits the attested owner with every capability and ownerLocal in ready', async () => {
    const { owner, ownerClient, nonces, ports, iat } = setup()
    const token = localCredential(
      { kind: 'owner', machineId, client: ownerClient, nonce: nonces.issue()!, iat: iat() },
      owner.privateKey,
    )
    const result = await attempt(createLocalAuth(ports), token)
    if (!('accepted' in result)) throw new Error(`refused ${String(result.refused)}`)
    const { accepted } = result
    expect(accepted.principal).toEqual({ kind: 'owner', clientId: ownerClient.id })
    expect(accepted.caps).toEqual(hello.capabilities)
    const ready = accepted.ready('c'.repeat(64), 'conn')
    expect(ready).toMatchObject({ ownerLocal: true, client: ownerClient })
    expect(ready.hello.hostId).toBe(machineId)
    expect(ready.capabilities).toContain('machine.configure')
  })

  it('admits any other caller as local, reading only, with its lane for attribution', async () => {
    const { nonces, ports, iat } = setup()
    const token = localCredential({
      kind: 'local',
      machineId,
      nonce: nonces.issue()!,
      iat: iat(),
      lane: 'abc',
    })
    const result = await attempt(createLocalAuth(ports), token)
    if (!('accepted' in result)) throw new Error('refused')
    expect(result.accepted.principal).toMatchObject({ kind: 'local', lane: 'abc' })
    expect(result.accepted.caps).toEqual(['sessions.read'])
    expect(result.accepted.caps.every((cap) => LOCAL_CAPABILITIES.includes(cap))).toBe(true)
    expect(result.accepted.ready('c'.repeat(64), 'conn').ownerLocal).toBeUndefined()
  })

  it('refuses a bad signature, an unpaired owner, a wrong machine and a stale iat', async () => {
    const { ownerClient, nonces, ports, iat } = setup()
    const stranger = localKeyPair()
    const owner = (overrides: object, key = stranger.privateKey) =>
      localCredential(
        {
          kind: 'owner',
          machineId,
          client: ownerClient,
          nonce: nonces.issue()!,
          iat: iat(),
          ...overrides,
        },
        key,
      )
    const auth = () => createLocalAuth(ports)
    expect(await attempt(auth(), owner({}))).toEqual({ refused: [4401, 'signature'] })
    expect(
      await attempt(auth(), owner({ client: { id: randomUUID(), label: 'Desktop' } })),
    ).toEqual({
      refused: [4403, 'owner-unknown'],
    })
    const local = (overrides: object) =>
      localCredential({
        kind: 'local',
        machineId,
        nonce: nonces.issue()!,
        iat: iat(),
        ...overrides,
      })
    expect(await attempt(auth(), local({ machineId: randomUUID() }))).toEqual({
      refused: [4403, 'machine'],
    })
    for (const skew of [-61, 61])
      expect(await attempt(auth(), local({ iat: iat() + skew }))).toEqual({
        refused: [4401, 'stale'],
      })
  })

  it('refuses a reused, expired or unknown nonce', async () => {
    const { nonces, ports, iat, clock } = setup()
    const nonce = nonces.issue()!
    const token = localCredential({ kind: 'local', machineId, nonce, iat: iat() })
    expect(await attempt(createLocalAuth(ports), token)).toHaveProperty('accepted')
    expect(await attempt(createLocalAuth(ports), token)).toEqual({ refused: [4401, 'nonce'] })
    const expiring = nonces.issue()!
    clock.now += LOCAL_LIMITS.nonceTtlMs
    const late = localCredential({ kind: 'local', machineId, nonce: expiring, iat: iat() })
    expect(await attempt(createLocalAuth(ports), late)).toEqual({ refused: [4401, 'nonce'] })
    const unknown = localCredential({ kind: 'local', machineId, nonce: 'a'.repeat(64), iat: iat() })
    expect(await attempt(createLocalAuth(ports), unknown)).toEqual({ refused: [4401, 'nonce'] })
  })

  it('refuses a lane on an owner credential, an unsigned owner and a grant token', async () => {
    const { owner, ownerClient, nonces, ports, iat } = setup()
    const payload = grantUtf8(
      JSON.stringify({
        v: 1,
        kind: 'owner',
        machineId,
        client: ownerClient,
        nonce: nonces.issue()!,
        iat: iat(),
        lane: 'abc',
      }),
    )
    const withLane = `${LOCAL_CREDENTIAL_PREFIX}${encodeBase64url(payload)}.${encodeBase64url(
      sign(null, payload, owner.privateKey),
    )}`
    expect(await attempt(createLocalAuth(ports), withLane)).toEqual({ refused: [4401, 'token'] })
    const unsigned = `${LOCAL_CREDENTIAL_PREFIX}${encodeBase64url(payload)}.`
    expect(await attempt(createLocalAuth(ports), unsigned)).toEqual({ refused: [4401, 'token'] })
    const grant = encodeGrant(
      {
        v: 1,
        iss: 'https://example.com',
        kid: 'k',
        sub: randomUUID(),
        sid: randomUUID(),
        hostId: machineId,
        epoch: 1,
        client: ownerClient,
        caps: ['sessions.read'],
        iat: iat(),
        exp: iat() + 300,
        jti: randomBytes(8).toString('hex'),
      },
      (bytes) => sign(null, bytes, owner.privateKey),
    )
    expect(grant.startsWith('phosphor-grant.')).toBe(true)
    expect(await attempt(createLocalAuth(ports), grant)).toEqual({ refused: [4401, 'token'] })
  })

  it('renews only the same kind, client and lane, without a challenge, and admits once', async () => {
    const { nonces, ports, iat } = setup()
    const client = { id: randomUUID(), label: 'phosphor CLI' }
    const token = () =>
      localCredential({ kind: 'local', machineId, client, nonce: nonces.issue()!, iat: iat() })
    const auth = createLocalAuth(ports)
    expect(await attempt(auth, token())).toHaveProperty('accepted')
    expect(await attempt(auth, token(), null)).toHaveProperty('accepted')
    expect(await attempt(auth, token())).toEqual({ refused: [4403, 'identity'] })
    const other = localCredential({ kind: 'local', machineId, nonce: nonces.issue()!, iat: iat() })
    expect(await attempt(auth, other, null)).toEqual({ refused: [4403, 'identity'] })
    expect(await attempt(createLocalAuth(ports), token(), 'c'.repeat(64), false)).toEqual({
      refused: [4429, 'connections'],
    })
  })
})

describe('the TCP listener', () => {
  it('refuses a phosphor-local credential before any key lookup', async () => {
    const { nonces, iat } = setup()
    const control = generateKeyPairSync('ed25519')
    const host = generateKeyPairSync('ed25519')
    const authority = createAuthority()
    authority.accept({ accepted: true, nextInSec: 30, ownerId: randomUUID(), epoch: 1 })
    let looked = false
    const auth = fixtureGrantAuth(
      authority,
      { iss: 'https://example.com', kid: 'k' },
      { control, host },
      hello,
      {
        keyset: {
          get: async () => {
            looked = true
            return control.publicKey
          },
        },
      },
    )
    const token = localCredential({ kind: 'local', machineId, nonce: nonces.issue()!, iat: iat() })
    expect(await attempt(auth, token)).toEqual({ refused: [4401, 'token'] })
    expect(looked).toBe(false)
  })
})
