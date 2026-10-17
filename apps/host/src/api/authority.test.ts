import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AUTHORITY_LIMITS, createAuthority } from './authority'

it('starts closed, retains missing fields and fails closed instead of dropping revocations at the cap', () => {
  let now = 0
  const authority = createAuthority(() => now)
  const ownerId = randomUUID()
  expect(authority.snapshot()).toBeNull()
  authority.accept({ accepted: true, nextInSec: 30, ownerId })
  expect(authority.snapshot()).toBeNull()
  authority.accept({ accepted: true, nextInSec: 30, epoch: 0 })
  expect(authority.snapshot()).toMatchObject({ owner: ownerId, epoch: 0 })
  const ids = Array.from({ length: AUTHORITY_LIMITS.revocations }, () => randomUUID())
  for (const id of ids) {
    authority.accept({ accepted: true, nextInSec: 30, revoked: { sessions: [id], clients: [id] } })
    now++
  }
  const first = ids[0],
    second = ids[1]
  if (!first || !second) throw new Error('Missing test ids')
  expect(authority.snapshot()?.revokedSessions.size).toBe(1000)
  expect(authority.snapshot()?.revokedClients.size).toBe(1000)
  expect(authority.snapshot()?.revokedSessions.has(first)).toBe(true)
  authority.accept({ accepted: true, nextInSec: 30, revoked: { sessions: [second], clients: [] } })
  expect(authority.snapshot()?.revokedSessions.size).toBe(1000)
  authority.accept({ accepted: true, nextInSec: 30 })
  expect(authority.snapshot()?.revokedSessions.has(second)).toBe(true)
  now = AUTHORITY_LIMITS.retentionMs + 999
  expect(authority.snapshot()?.revokedClients.size).toBe(0)
  expect(authority.snapshot()?.revokedSessions.has(first)).toBe(false)
  expect(authority.snapshot()?.revokedSessions.has(second)).toBe(true)
  now++
  expect(authority.snapshot()?.revokedSessions.has(second)).toBe(false)
  for (let i = 0; i <= AUTHORITY_LIMITS.revocations; i++)
    authority.accept({
      accepted: true,
      nextInSec: 30,
      revoked: { sessions: [randomUUID()], clients: [] },
    })
  expect(authority.snapshot()).toBeNull()
  now += AUTHORITY_LIMITS.retentionMs
  authority.remove()
  authority.accept({
    accepted: true,
    nextInSec: 30,
    ownerId,
    epoch: 1,
    revoked: { sessions: [], clients: [] },
  })
  expect(authority.snapshot()).toBeNull()
})
