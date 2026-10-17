import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeartbeatResponse } from '@phosphor/shared/control-api'
import { encodeGrant, GRANT_LIMITS, type GrantPayload } from '@phosphor/shared/host-grant'
import { parseHostFrame } from '@phosphor/shared/host-protocol'
import { AUTHORITY_LIMITS, createAuthority, type Authority } from './authority'
import { startApi } from './server'

const { revocations: cap, retentionMs } = AUTHORITY_LIMITS
const kinds = ['sessions', 'clients'] as const
type Kind = (typeof kinds)[number]
const owner = { ownerId: randomUUID(), epoch: 1 }
const freshIds = (count: number) => Array.from({ length: count }, () => randomUUID())
const beat = (reply: Omit<HeartbeatResponse, 'accepted' | 'nextInSec'>): HeartbeatResponse => ({
  accepted: true,
  nextInSec: 30,
  ...reply,
})
const revoked = (kind: Kind, ids: readonly string[]) => ({
  sessions: kind === 'sessions' ? [...ids] : [],
  clients: kind === 'clients' ? [...ids] : [],
})
/** Control sends at most GRANT_LIMITS.revocations ids per list in one heartbeat. */
function revokeInBatches(
  authority: Authority,
  kind: Kind,
  ids: readonly string[],
  fields: Omit<HeartbeatResponse, 'accepted' | 'nextInSec' | 'revoked'> = {},
) {
  for (let i = 0; i < ids.length; i += GRANT_LIMITS.revocations)
    authority.accept(
      beat({ ...fields, revoked: revoked(kind, ids.slice(i, i + GRANT_LIMITS.revocations)) }),
    )
}
const listed = (authority: Authority, kind: Kind, id: string) =>
  kind === 'sessions'
    ? authority.snapshot()?.revokedSessions.has(id)
    : authority.snapshot()?.revokedClients.has(id)

function openAuthority(start = 0) {
  const clock = { now: start }
  const authority = createAuthority(() => clock.now)
  authority.accept(beat(owner))
  expect(authority.snapshot()).toMatchObject({ owner: owner.ownerId, epoch: owner.epoch })
  return { clock, authority }
}

describe.each(kinds)('%s revocation overflow', (kind) => {
  it('never re-admits the first of cap + 1 distinct live ids sent in bounded batches', () => {
    const { clock, authority } = openAuthority()
    const seen: (ReturnType<Authority['snapshot']> | 'null')[] = []
    authority.onChange(() => seen.push(authority.snapshot() ?? 'null'))
    const ids = freshIds(cap + 1)
    const first = ids[0] ?? ''
    revokeInBatches(authority, kind, ids.slice(0, cap))
    clock.now += 1000
    // Re-reporting known ids at the cap refreshes them without using capacity.
    revokeInBatches(authority, kind, ids.slice(cap - GRANT_LIMITS.revocations, cap))
    expect(authority.snapshot()).not.toBeNull()
    expect(listed(authority, kind, first)).toBe(true)
    revokeInBatches(authority, kind, ids.slice(cap))
    expect(authority.snapshot()).toBeNull()
    expect(seen.at(-1)).toBe('null')
    for (const snapshot of seen)
      if (snapshot !== 'null')
        expect(
          (kind === 'sessions' ? snapshot?.revokedSessions : snapshot?.revokedClients)?.has(first),
        ).toBe(true)
  })

  it('stays closed through missing heartbeats, missing fields and an emptying map', () => {
    const { clock, authority } = openAuthority()
    revokeInBatches(authority, kind, freshIds(cap + 1))
    expect(authority.snapshot()).toBeNull()
    clock.now += 3 * retentionMs
    expect(authority.snapshot()).toBeNull()
    authority.accept(beat({}))
    authority.accept(beat(owner))
    authority.accept(beat({ ownerId: owner.ownerId, revoked: revoked(kind, []) }))
    authority.accept(beat({ epoch: owner.epoch, revoked: revoked(kind, freshIds(1)) }))
    expect(authority.snapshot()).toBeNull()
  })

  it('reopens only on a complete heartbeat that fits, a full horizon after the last overflow', () => {
    const { clock, authority } = openAuthority()
    const ids = freshIds(cap + 1)
    revokeInBatches(authority, kind, ids, owner)
    expect(authority.snapshot()).toBeNull()
    clock.now += retentionMs / 3
    revokeInBatches(authority, kind, freshIds(1), owner)
    let deadline = clock.now + retentionMs
    clock.now = deadline - 1
    authority.accept(beat({ ...owner, revoked: revoked(kind, []) }))
    expect(authority.snapshot()).toBeNull()
    clock.now = deadline
    // Past the deadline, a complete heartbeat whose new ids do not fit extends it.
    revokeInBatches(authority, kind, freshIds(cap))
    expect(authority.snapshot()).toBeNull()
    authority.accept(beat({ ...owner, revoked: revoked(kind, freshIds(1)) }))
    expect(authority.snapshot()).toBeNull()
    deadline = clock.now + retentionMs
    clock.now = deadline - 1
    authority.accept(beat({ ...owner, revoked: revoked(kind, []) }))
    expect(authority.snapshot()).toBeNull()
    clock.now = deadline
    const kept = freshIds(2)
    authority.accept(beat({ ...owner, revoked: revoked(kind, kept) }))
    expect(authority.snapshot()).toMatchObject({ owner: owner.ownerId, epoch: owner.epoch })
    for (const id of kept) expect(listed(authority, kind, id)).toBe(true)
    expect(listed(authority, kind, ids[0] ?? '')).toBe(false)
    authority.remove()
    authority.accept(beat({ ...owner, revoked: revoked(kind, []) }))
    expect(authority.snapshot()).toBeNull()
  })

  it('a backward clock step never shortens the quarantine or a refreshed revocation', () => {
    const start = 10 * retentionMs
    const { clock, authority } = openAuthority(start)
    const held = randomUUID()
    authority.accept(beat({ revoked: revoked(kind, [held]) }))
    clock.now = start - 60 * 60 * 1000
    authority.accept(beat({ revoked: revoked(kind, [held]) }))
    clock.now += retentionMs
    expect(listed(authority, kind, held)).toBe(true)
    clock.now = start + retentionMs - 1
    expect(listed(authority, kind, held)).toBe(true)
    clock.now = start + retentionMs
    expect(listed(authority, kind, held)).toBe(false)

    clock.now = start
    revokeInBatches(authority, kind, freshIds(cap + 1))
    expect(authority.snapshot()).toBeNull()
    for (const now of [0, retentionMs, start + retentionMs - 1]) {
      clock.now = now
      authority.accept(beat({ ...owner, revoked: revoked(kind, []) }))
      expect(authority.snapshot()).toBeNull()
    }
    clock.now = start + retentionMs
    authority.accept(beat({ ...owner, revoked: revoked(kind, []) }))
    expect(authority.snapshot()).not.toBeNull()
  })
})

describe.each(kinds)('Host API after a %s revocation overflow', (kind) => {
  let api: ReturnType<typeof startApi> | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await api?.stop()
    api = undefined
  })

  it('closes admitted streams and refuses the first revoked grant until recovery', async () => {
    const port = await freePort()
    const control = generateKeyPairSync('ed25519')
    const host = generateKeyPairSync('ed25519')
    const iat = Math.floor(Date.now() / 1000)
    const claims: GrantPayload = {
      v: 1,
      iss: 'http://localhost:12345',
      kid: 'test-key',
      sub: owner.ownerId,
      sid: randomUUID(),
      hostId: randomUUID(),
      epoch: owner.epoch,
      client: { id: randomUUID(), label: 'Overflow client' },
      caps: [],
      iat,
      exp: iat + 300,
      jti: randomBytes(8).toString('hex'),
    }
    const mint = (overrides: Partial<GrantPayload>) =>
      encodeGrant({ ...claims, ...overrides }, (bytes) => sign(null, bytes, control.privateKey))
    const fresh = () => ({
      sid: randomUUID(),
      client: { id: randomUUID(), label: 'Overflow client' },
    })
    const clock = { now: 0 }
    const authority = createAuthority(() => clock.now)
    const logs: string[] = []
    api = startApi({
      authority,
      port,
      origin: claims.iss,
      hostId: claims.hostId,
      hostVersion: 'test',
      key: host.privateKey,
      fetch: async () =>
        Response.json({
          keys: [{ kid: claims.kid, publicKey: control.publicKey.export({ format: 'jwk' }).x }],
        }),
      log: (event) => logs.push(event),
    })
    authority.accept(beat(owner))
    await vi.waitFor(() => expect(logs).toContain('api.listening'))

    async function attempt(overrides: Partial<GrantPayload>) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
      sockets.push(ws)
      ws.on('error', () => {})
      const upgrade = await new Promise<number>((resolve) => {
        ws.once('open', () => resolve(101))
        ws.once('unexpected-response', (_request, response: IncomingMessage) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
      })
      if (upgrade !== 101) return { ws, upgrade }
      const answer = once(ws, 'message')
      ws.send(JSON.stringify({ type: 'auth', grant: mint(overrides), challenge: 'a'.repeat(64) }))
      const frame = parseHostFrame(String((await answer)[0]))
      if (!frame.ok) throw new Error('Invalid frame')
      return { ws, upgrade, frame: frame.value.type }
    }

    const target = fresh()
    const first = kind === 'sessions' ? target.sid : target.client.id
    authority.accept(beat({ revoked: revoked(kind, [first]) }))
    expect((await attempt(target)).frame).toBe('error')
    const admitted = await attempt(fresh())
    expect(admitted.frame).toBe('ready')
    let admittedClose: number | undefined
    admitted.ws.on('close', (code) => {
      admittedClose = code
    })

    clock.now += 1000
    revokeInBatches(authority, kind, freshIds(cap))
    const refused = await attempt(target)
    expect({ upgrade: refused.upgrade, frame: refused.frame }).toEqual({
      upgrade: 503,
      frame: undefined,
    })
    await vi.waitFor(() => expect(admittedClose).toBe(4403))

    clock.now += retentionMs
    authority.accept(beat({ ...owner, revoked: revoked(kind, [first]) }))
    expect((await attempt(target)).frame).toBe('error')
    expect((await attempt(fresh())).frame).toBe('ready')
  })
})

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
