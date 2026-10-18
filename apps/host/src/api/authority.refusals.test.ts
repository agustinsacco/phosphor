import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HeartbeatResponse } from '@phosphor/shared/control-api'
import { GRANT_LIMITS } from '@phosphor/shared/host-grant'
import { AUTHORITY_LIMITS, createAuthority, type Authority } from './authority'

const { revocations: cap, retentionMs } = AUTHORITY_LIMITS
const kinds = ['sessions', 'clients'] as const
type Kind = (typeof kinds)[number]
type Fields = Omit<HeartbeatResponse, 'accepted' | 'nextInSec'>
const owner = { ownerId: randomUUID(), epoch: 1 }
const freshIds = (count: number) => Array.from({ length: count }, () => randomUUID())
const beat = (fields: Fields): HeartbeatResponse => ({ accepted: true, nextInSec: 30, ...fields })
const revoked = (kind: Kind, ids: readonly string[]) => ({
  sessions: kind === 'sessions' ? [...ids] : [],
  clients: kind === 'clients' ? [...ids] : [],
})
const listed = (authority: Authority, kind: Kind, id: string) => {
  const snapshot = authority.snapshot()
  if (!snapshot) throw new Error('The authority is closed')
  return (kind === 'sessions' ? snapshot.revokedSessions : snapshot.revokedClients).has(id)
}
/** Control sends at most GRANT_LIMITS.revocations ids per list in one heartbeat. */
function revokeInBatches(authority: Authority, kind: Kind, ids: readonly string[]) {
  for (let i = 0; i < ids.length; i += GRANT_LIMITS.revocations)
    authority.accept(beat({ revoked: revoked(kind, ids.slice(i, i + GRANT_LIMITS.revocations)) }))
}
function openAuthority(start = 0) {
  const clock = { now: start }
  const authority = createAuthority(() => clock.now)
  authority.accept(beat(owner))
  expect(authority.snapshot()).not.toBeNull()
  return { clock, authority }
}

describe('an authority without both owner and epoch stays closed', () => {
  it.each<[string, Fields[]]>([
    ['no heartbeat', []],
    ['an empty heartbeat', [{}]],
    ['only an owner', [{ ownerId: owner.ownerId }]],
    ['only an epoch', [{ epoch: owner.epoch }]],
    ['only revocations', [{ revoked: { sessions: freshIds(1), clients: freshIds(1) } }]],
    [
      'an owner with revocations, repeated',
      [
        { ownerId: owner.ownerId, revoked: { sessions: [], clients: [] } },
        { ownerId: randomUUID() },
      ],
    ],
    ['an epoch with revocations, repeated', [{ epoch: 1, revoked: undefined }, { epoch: 2 }]],
  ])('refuses after %s', (_kind, beats) => {
    const authority = createAuthority(() => 0)
    for (const fields of beats) authority.accept(beat(fields))
    expect(authority.snapshot()).toBeNull()
  })

  it.each<[string, Fields[]]>([
    ['owner then epoch', [{ ownerId: owner.ownerId }, { epoch: owner.epoch }]],
    ['epoch then owner', [{ epoch: owner.epoch }, { ownerId: owner.ownerId }]],
    ['both at once', [owner]],
  ])('opens with %s and keeps revocations sent while closed', (_kind, beats) => {
    const authority = createAuthority(() => 0)
    const [session, client] = freshIds(2)
    if (!session || !client) throw new Error('Missing test ids')
    authority.accept(beat({ revoked: { sessions: [session], clients: [client] } }))
    for (const fields of beats) authority.accept(beat(fields))
    expect(authority.snapshot()).toEqual({
      owner: owner.ownerId,
      epoch: owner.epoch,
      revokedSessions: new Set([session]),
      revokedClients: new Set([client]),
    })
  })
})

describe('missing heartbeat fields are no news', () => {
  it('keeps the owner and epoch a later heartbeat leaves out', () => {
    const { authority } = openAuthority()
    const expected = { owner: owner.ownerId, epoch: owner.epoch }
    authority.accept(beat({}))
    expect(authority.snapshot()).toMatchObject(expected)
    authority.accept(beat({ revoked: { sessions: freshIds(1), clients: [] } }))
    expect(authority.snapshot()).toMatchObject(expected)
    authority.accept(beat({ ownerId: owner.ownerId }))
    expect(authority.snapshot()).toMatchObject(expected)
    authority.accept(beat({ epoch: owner.epoch }))
    expect(authority.snapshot()).toMatchObject(expected)
  })

  it.each(kinds)('never forgets a live %s revocation a later heartbeat leaves out', (kind) => {
    const { clock, authority } = openAuthority()
    const [held, other] = freshIds(2)
    if (!held || !other) throw new Error('Missing test ids')
    authority.accept(beat({ revoked: revoked(kind, [held]) }))
    for (const fields of [
      {},
      owner,
      { revoked: revoked(kind, []) },
      { revoked: revoked(kind, [other]) },
    ]) {
      clock.now += 1000
      authority.accept(beat(fields))
      expect(listed(authority, kind, held)).toBe(true)
    }
  })
})

describe.each(kinds)('%s revocation preservation', (kind) => {
  it('holds an id for the full retention after its latest report', () => {
    const { clock, authority } = openAuthority()
    const [id] = freshIds(1)
    if (!id) throw new Error('Missing test id')
    authority.accept(beat({ revoked: revoked(kind, [id]) }))
    clock.now = retentionMs - 1
    expect(listed(authority, kind, id)).toBe(true)
    authority.accept(beat({ revoked: revoked(kind, [id]) }))
    clock.now = 2 * retentionMs - 2
    expect(listed(authority, kind, id)).toBe(true)
    clock.now = 2 * retentionMs - 1
    expect(listed(authority, kind, id)).toBe(false)
  })

  it('does not list an id under the other kind', () => {
    const { authority } = openAuthority()
    const [id] = freshIds(1)
    if (!id) throw new Error('Missing test id')
    authority.accept(beat({ revoked: revoked(kind, [id]) }))
    expect(listed(authority, kind, id)).toBe(true)
    expect(listed(authority, kind === 'sessions' ? 'clients' : 'sessions', id)).toBe(false)
  })

  it('hands out copies, so a caller cannot un-revoke an id', () => {
    const { authority } = openAuthority()
    const [id] = freshIds(1)
    if (!id) throw new Error('Missing test id')
    authority.accept(beat({ revoked: revoked(kind, [id]) }))
    const first = authority.snapshot()
    const list = kind === 'sessions' ? first?.revokedSessions : first?.revokedClients
    list?.delete(id)
    list?.clear()
    expect(listed(authority, kind, id)).toBe(true)
  })

  it('reuses the capacity of expired ids without closing', () => {
    const { clock, authority } = openAuthority()
    const old = freshIds(cap)
    revokeInBatches(authority, kind, old)
    expect(authority.snapshot()).not.toBeNull()
    clock.now = retentionMs
    const next = freshIds(cap)
    revokeInBatches(authority, kind, next)
    expect(authority.snapshot()).not.toBeNull()
    expect(next.every((id) => listed(authority, kind, id))).toBe(true)
    expect(old.some((id) => listed(authority, kind, id))).toBe(false)
  })

  it('closes when this list overflows although the other list fits', () => {
    const { authority } = openAuthority()
    revokeInBatches(authority, kind, freshIds(cap))
    const other = kind === 'sessions' ? 'clients' : 'sessions'
    authority.accept(
      beat({ ...owner, revoked: { ...revoked(kind, freshIds(1)), [other]: freshIds(1) } }),
    )
    expect(authority.snapshot()).toBeNull()
  })
})

describe('removal is permanent', () => {
  const recoveries = (authority: Authority, clock: { now: number }) => {
    for (let step = 0; step < 3; step++) {
      clock.now += 2 * retentionMs
      authority.accept(beat({ ...owner, revoked: { sessions: [], clients: [] } }))
      authority.accept(beat({ ownerId: randomUUID(), epoch: owner.epoch + step + 1 }))
      expect(authority.snapshot()).toBeNull()
    }
  }

  it('before the authority ever opened', () => {
    const clock = { now: 0 }
    const authority = createAuthority(() => clock.now)
    authority.remove()
    recoveries(authority, clock)
  })

  it('while open', () => {
    const { clock, authority } = openAuthority()
    authority.remove()
    expect(authority.snapshot()).toBeNull()
    recoveries(authority, clock)
  })

  it('during an overflow quarantine', () => {
    const { clock, authority } = openAuthority()
    revokeInBatches(authority, 'sessions', freshIds(cap + 1))
    authority.remove()
    recoveries(authority, clock)
  })

  it('notifies listeners of removal and every heartbeat until they unsubscribe', () => {
    const { authority } = openAuthority()
    const seen: (ReturnType<Authority['snapshot']> | 'closed')[] = []
    const listener = vi.fn(() => seen.push(authority.snapshot() ?? 'closed'))
    const unsubscribe = authority.onChange(listener)
    authority.accept(beat({}))
    authority.remove()
    expect(seen).toEqual([expect.objectContaining({ owner: owner.ownerId }), 'closed'])
    unsubscribe()
    authority.accept(beat(owner))
    authority.remove()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
