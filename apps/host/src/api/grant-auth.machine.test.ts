import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  encodeBase64url,
  encodeGrant,
  GRANT_PREFIX,
  grantUtf8,
  type GrantPayload,
} from '@phosphor/shared/host-grant'
import { AUTHORITY_LIMITS, createAuthority } from './authority'
import { createGrantAuth, type AuthOutcome } from './grant-auth'

/** A Host and control pair, with a machine grant minted the way control mints one. */
function fixture() {
  const control = generateKeyPairSync('ed25519')
  const host = generateKeyPairSync('ed25519')
  const iat = Math.floor(Date.now() / 1000)
  const user: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'stark' },
    caps: ['sessions.read'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const machineId = randomUUID()
  const machine: GrantPayload = { ...user, caps: [], origin: 'machine', machine: machineId }
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: user.sub, epoch: user.epoch })
  const auth = () =>
    createGrantAuth({
      authority,
      keyset: { get: async (kid) => (kid === user.kid ? control.publicKey : undefined) },
      origin: user.iss,
      hello: {
        hostId: user.hostId,
        hostVersion: 'test',
        protocolVersion: 1,
        runtimeEpoch: '0123456789abcdef',
        capabilities: ['sessions.read', 'sessions.control', 'terminal'],
      },
      key: host.privateKey,
    })
  const mint = (payload: GrantPayload) =>
    encodeGrant(payload, (bytes) => sign(null, bytes, control.privateKey))
  /** Signs any JSON as control would, bypassing `encodeGrant`'s parser. */
  const mintRaw = (payload: Record<string, unknown>) => {
    const bytes = grantUtf8(JSON.stringify(payload))
    const signature = sign(null, bytes, control.privateKey)
    return GRANT_PREFIX + encodeBase64url(bytes) + '.' + encodeBase64url(signature)
  }
  return { auth, authority, user, machine, machineId, mint, mintRaw }
}

function outcome() {
  return {
    ended: () => false,
    refuse: vi.fn<AuthOutcome['refuse']>(),
    admit: vi.fn<AuthOutcome['admit']>(() => true),
    accept: vi.fn<AuthOutcome['accept']>(),
  }
}
const CHALLENGE = 'a'.repeat(64)

describe('machine-origin grants', () => {
  it('refuses a machine grant 4403 until the Host opts in to machine ops', async () => {
    const f = fixture()
    const o = outcome()
    await f.auth().verify(f.mint(f.machine), CHALLENGE, o)
    expect(o.refuse).toHaveBeenCalledWith(4403, 'machine-origin')
    expect(o.accept).not.toHaveBeenCalled()
  })

  it('refuses a machine grant while control says reach is off, even when opted in', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    f.authority.accept({ accepted: true, nextInSec: 30, machineReach: false })
    const o = outcome()
    await f.auth().verify(f.mint(f.machine), CHALLENGE, o)
    expect(o.refuse).toHaveBeenCalledWith(4403, 'machine-origin')
  })

  it('admits an opted-in machine grant as a machine principal with no caps', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const o = outcome()
    await f.auth().verify(f.mint(f.machine), CHALLENGE, o)
    expect(o.refuse).not.toHaveBeenCalled()
    const accepted = o.accept.mock.calls[0]?.[0]
    expect(accepted?.principal).toEqual({
      kind: 'grant-machine',
      clientId: f.user.client.id,
      machineId: f.machineId,
    })
    expect(accepted?.caps).toEqual([])
    expect(accepted?.ready(CHALLENGE, 'c')).toMatchObject({ capabilities: [] })
  })

  it.each([
    ['caps', { caps: ['sessions.read'] }],
    ['configure', { configure: true }],
    ['a missing machine id', { machine: undefined }],
  ])('refuses a machine grant that carries %s', async (_name, change) => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const o = outcome()
    await f.auth().verify(f.mintRaw({ ...f.machine, ...change }), CHALLENGE, o)
    expect(o.refuse).toHaveBeenCalledWith(4401, 'token')
    expect(o.accept).not.toHaveBeenCalled()
  })

  it('refuses a machine grant that lives longer than 300 s', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const o = outcome()
    await f.auth().verify(f.mint({ ...f.machine, exp: f.machine.iat + 301 }), CHALLENGE, o)
    expect(o.refuse).toHaveBeenCalledWith(4403, 'lifetime')
  })

  it('renews only with the same identity: a user grant cannot renew a machine one, nor back', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const machineAuth = f.auth()
    await machineAuth.verify(f.mint(f.machine), CHALLENGE, outcome())
    const asUser = outcome()
    await machineAuth.verify(f.mint(f.user), undefined, asUser)
    expect(asUser.refuse).toHaveBeenCalledWith(4403, 'identity')
    const otherMachine = outcome()
    await machineAuth.verify(
      f.mint({ ...f.machine, machine: randomUUID() }),
      undefined,
      otherMachine,
    )
    expect(otherMachine.refuse).toHaveBeenCalledWith(4403, 'identity')
    const same = outcome()
    await machineAuth.verify(f.mint(f.machine), undefined, same)
    expect(same.accept).toHaveBeenCalledOnce()

    const userAuth = f.auth()
    await userAuth.verify(f.mint(f.user), CHALLENGE, outcome())
    const asMachine = outcome()
    await userAuth.verify(f.mint(f.machine), undefined, asMachine)
    expect(asMachine.refuse).toHaveBeenCalledWith(4403, 'identity')
  })

  it('loses a machine connection when the opt-in drops or control turns reach off', async () => {
    for (const drop of [
      (f: Fixture) => f.authority.setMachineOps(false),
      (f: Fixture) => f.authority.accept({ accepted: true, nextInSec: 30, machineReach: false }),
    ]) {
      const f = fixture()
      f.authority.setMachineOps(true)
      const machineAuth = f.auth()
      const userAuth = f.auth()
      const machineLost = vi.fn()
      const userLost = vi.fn()
      machineAuth.watch(machineLost)
      userAuth.watch(userLost)
      await machineAuth.verify(f.mint(f.machine), CHALLENGE, outcome())
      await userAuth.verify(f.mint(f.user), CHALLENGE, outcome())
      drop(f)
      expect(machineLost).toHaveBeenCalledOnce()
      expect(userLost).not.toHaveBeenCalled()
    }
  })

  it('loses a machine connection on the first beat that revokes its principal', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const auth = f.auth()
    const lost = vi.fn()
    auth.watch(lost)
    await auth.verify(f.mint(f.machine), CHALLENGE, outcome())
    f.authority.accept({
      accepted: true,
      nextInSec: 30,
      revoked: { sessions: [], clients: [f.machine.client.id] },
    })
    expect(lost).toHaveBeenCalledOnce()
    const again = outcome()
    await f.auth().verify(f.mint(f.machine), CHALLENGE, again)
    expect(again.refuse).toHaveBeenCalledWith(4403, 'revoked-client')
  })

  it('holds at most machineConnections machine sockets and frees a slot when one ends', async () => {
    const f = fixture()
    f.authority.setMachineOps(true)
    const ends: (() => void)[] = []
    for (let i = 0; i < AUTHORITY_LIMITS.machineConnections; i++) {
      const auth = f.auth()
      ends.push(auth.watch(() => {}))
      const o = outcome()
      await auth.verify(
        f.mint({ ...f.machine, client: { id: randomUUID(), label: 'stark' } }),
        CHALLENGE,
        o,
      )
      expect(o.accept).toHaveBeenCalledOnce()
    }
    const over = outcome()
    const extra = f.auth()
    extra.watch(() => {})
    await extra.verify(f.mint(f.machine), CHALLENGE, over)
    expect(over.refuse).toHaveBeenCalledWith(4429, 'machine-connections')
    const user = outcome()
    await f.auth().verify(f.mint(f.user), CHALLENGE, user)
    expect(user.accept).toHaveBeenCalledOnce()
    ends[0]?.()
    const freed = outcome()
    await f.auth().verify(f.mint(f.machine), CHALLENGE, freed)
    expect(freed.accept).toHaveBeenCalledOnce()
  })
})

type Fixture = ReturnType<typeof fixture>
