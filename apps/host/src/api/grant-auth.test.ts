import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import { createAuthority } from './authority'
import { createGrantAuth, type AuthOutcome, type GrantAuthPorts } from './grant-auth'

function fixture(ports: Partial<GrantAuthPorts> = {}) {
  const control = generateKeyPairSync('ed25519')
  const wrong = generateKeyPairSync('ed25519')
  const host = generateKeyPairSync('ed25519')
  const iat = Math.floor(Date.now() / 1000)
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'Viewer' },
    caps: ['sessions.read'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: claims.epoch })
  const auth = createGrantAuth({
    authority,
    keyset: { get: async (kid) => (kid === claims.kid ? control.publicKey : undefined) },
    origin: claims.iss,
    hello: {
      hostId: claims.hostId,
      hostVersion: 'test',
      protocolVersion: 1,
      runtimeEpoch: '0123456789abcdef',
      capabilities: ['sessions.read', 'sessions.control'],
    },
    key: host.privateKey,
    ...ports,
  })
  const mint = (overrides: Partial<GrantPayload> = {}, key = control.privateKey) =>
    encodeGrant({ ...claims, ...overrides }, (bytes) => sign(null, bytes, key))
  return { auth, authority, claims, mint, wrong }
}

function outcome(options: { ended?: boolean; admits?: boolean } = {}) {
  return {
    ended: () => options.ended ?? false,
    refuse: vi.fn<AuthOutcome['refuse']>(),
    admit: vi.fn<AuthOutcome['admit']>(() => options.admits ?? true),
    accept: vi.fn<AuthOutcome['accept']>(),
  }
}

describe('grant authentication', () => {
  it('accepts a first grant once admitted, with its granted caps and lapse time', async () => {
    const f = fixture({ webPushKey: 'B' + 'A'.repeat(86) })
    const o = outcome()
    await f.auth.verify(f.mint(), 'a'.repeat(64), o)
    expect(o.refuse).not.toHaveBeenCalled()
    expect(o.admit).toHaveBeenCalledWith(f.claims.client.id)
    const accepted = o.accept.mock.calls[0]?.[0]
    expect(accepted).toMatchObject({
      client: f.claims.client,
      caps: ['sessions.read'],
      closeAt: (f.claims.exp + CONTROL_LIMITS.signatureSkewSec) * 1000,
      grantExpiresAt: new Date(f.claims.exp * 1000).toISOString(),
    })
    expect(accepted?.ready('a'.repeat(64), 'connection')).toMatchObject({
      type: 'ready',
      connectionId: 'connection',
      client: f.claims.client,
      capabilities: ['sessions.read'],
      webPushKey: 'B' + 'A'.repeat(86),
    })
  })

  it.each([
    { name: 'a broken token', grant: () => 'broken', code: 4401, reason: 'token' },
    {
      name: 'an unknown key',
      grant: (f: Fixture) => f.mint({ kid: 'other' }),
      code: 4401,
      reason: 'signature',
    },
    {
      name: 'a wrong signature',
      grant: (f: Fixture) => f.mint({}, f.wrong.privateKey),
      code: 4401,
      reason: 'signature',
    },
    {
      name: 'another issuer',
      grant: (f: Fixture) => f.mint({ iss: 'https://x.example' }),
      code: 4403,
    },
  ])('refuses $name with its code', async ({ grant, code, reason }) => {
    const f = fixture()
    const o = outcome()
    await f.auth.verify(grant(f), 'a'.repeat(64), o)
    expect(o.refuse).toHaveBeenCalledWith(code, reason ?? expect.any(String))
    expect(o.accept).not.toHaveBeenCalled()
  })

  it('refuses without an authority, and when admission fails', async () => {
    const f = fixture()
    const o = outcome({ admits: false })
    await f.auth.verify(f.mint(), 'a'.repeat(64), o)
    expect(o.refuse).toHaveBeenCalledWith(4429, 'connections')
    f.authority.remove()
    const removed = outcome()
    await f.auth.verify(f.mint(), 'a'.repeat(64), removed)
    expect(removed.refuse).toHaveBeenCalledWith(4403, 'authority')
  })

  it('drops a result that arrives after the connection ended', async () => {
    const f = fixture()
    const o = outcome({ ended: true })
    await f.auth.verify(f.mint(), 'a'.repeat(64), o)
    expect(o.refuse).not.toHaveBeenCalled()
    expect(o.accept).not.toHaveBeenCalled()
  })

  it('renews only the same owner and client, without a challenge or a second admission', async () => {
    const f = fixture()
    await f.auth.verify(f.mint(), 'a'.repeat(64), outcome())
    const renewal = outcome()
    await f.auth.verify(f.mint(), undefined, renewal)
    expect(renewal.admit).not.toHaveBeenCalled()
    expect(renewal.accept).toHaveBeenCalledOnce()
    for (const [grant, challenge] of [
      [f.mint({ client: { id: randomUUID(), label: 'Other' } }), undefined],
      [f.mint(), 'a'.repeat(64)],
    ] as const) {
      const refused = outcome()
      await f.auth.verify(grant, challenge, refused)
      expect(refused.refuse).toHaveBeenCalledWith(4403, 'identity')
    }
  })

  it('loses the connection on a new owner or epoch, and on revoking its accepted grant', async () => {
    const f = fixture()
    const lost = vi.fn()
    const unsubscribe = f.auth.watch(lost)
    f.authority.accept({
      accepted: true,
      nextInSec: 30,
      revoked: { sessions: [f.claims.sid], clients: [] },
    })
    expect(lost).not.toHaveBeenCalled()
    await f.auth.verify(f.mint({ sid: randomUUID() }), 'a'.repeat(64), outcome())
    f.authority.accept({
      accepted: true,
      nextInSec: 30,
      revoked: { sessions: [], clients: [f.claims.client.id] },
    })
    expect(lost).toHaveBeenCalledOnce()
    f.authority.accept({ accepted: true, nextInSec: 30, ownerId: f.claims.sub, epoch: 2 })
    expect(lost).toHaveBeenCalledTimes(2)
    unsubscribe()
    f.authority.remove()
    expect(lost).toHaveBeenCalledTimes(2)
  })
})

type Fixture = ReturnType<typeof fixture>
