import type { TestContext } from 'vitest'
import { CONTROL_LIMITS } from '../../control-api'
import { challenge, otherClient } from './client'
import { scenario, scenarioEach, type ConformanceKit } from './context'

async function authFirstFrame({ flush, expect, client }: ConformanceKit) {
  const c = client()
  c.send({ type: 'ping', at: 0 })
  await flush()
  expect(c.closed).toEqual([4401])
  const timeout = client()
  await flush(20)
  expect(timeout.closed).toEqual([4401])
}
async function wrongGrantClaim(
  { h, flush, expect, client }: ConformanceKit,
  bad: 'signature' | 'host' | 'epoch' | 'owner',
) {
  const c = client()
  const claims =
    bad === 'host'
      ? { hostId: otherClient.id }
      : bad === 'epoch'
        ? { epoch: h.claims.epoch + 1 }
        : bad === 'owner'
          ? { sub: otherClient.id }
          : {}
  c.send({ type: 'auth', grant: h.mintGrant(claims, bad === 'signature'), challenge })
  await flush()
  expect(c.closed).toEqual([bad === 'signature' ? 4401 : 4403])
}
async function enrolledHostProof({ h, flush, expect, auth }: ConformanceKit) {
  const c = await auth()
  const ready = c.frames[0]
  if (!ready || ready.type !== 'ready') throw new Error('Missing ready')
  expect(ready.hello.hostId).toBe(h.claims.hostId)
  expect(h.publicKey.length).toBe(32)
  expect(h.verifyProof(ready, challenge)).toBe(true)
  expect(h.verifyProof(ready, 'b'.repeat(64))).toBe(false)
  c.send({ type: 'auth', grant: h.mintGrant() })
  await flush()
  expect(c.frames.at(-1)?.type).toBe('auth-renewed')
  c.send({ type: 'auth', grant: h.mintGrant({ client: otherClient }) })
  await flush()
  expect(c.closed).toEqual([4403])
  const expiring = await auth({ exp: h.claims.iat + 1 })
  await flush(30_000)
  expiring.send({ type: 'ping', at: 30_000 })
  await flush()
  expect(expiring.frames.at(-1)).toEqual({ type: 'pong', at: 30_000 })
  await flush((1 + CONTROL_LIMITS.signatureSkewSec) * 1000 - 30_000 - 1)
  expect(expiring.socket.isOpen()).toBe(true)
  await flush(1)
  expect(expiring.closed).toEqual([4401])
}
async function foreignHostHello({ h, expect, auth }: ConformanceKit) {
  const c = await auth()
  const ready = c.frames.find((frame) => frame.type === 'ready')
  if (!ready || ready.type !== 'ready') throw new Error('Missing ready')
  const hostId = otherClient.id
  const wrongHost = {
    ...ready,
    hello: { ...ready.hello, hostId },
    proof: h.signHelloProof(hostId, ready.hello.runtimeEpoch, challenge),
  }
  expect(h.verifyProof(wrongHost, challenge)).toBe(false)
}
async function revokedGrants(
  { h, flush, expect, client, auth }: ConformanceKit,
  kind: 'session' | 'client',
) {
  const c = await auth()
  if (kind === 'session') h.driver.revokeSession(h.claims.sid)
  else h.driver.revokeClient(h.claims.client.id)
  await flush()
  expect(c.closed).toEqual([4403])
  const next = client()
  next.send({ type: 'auth', grant: h.mintGrant(), challenge })
  await flush()
  expect(next.closed).toEqual([4403])
}
async function readAuthority(
  { h, lacks, flush, expect, auth, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    denied = await auth({ client: otherClient, caps: [] })
  denied.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  denied.send({ type: 'call', id: 'repositories', method: 'host.repositories' })
  await flush()
  expect(denied.frames).toContainEqual({
    type: 'subscribe-failed',
    id: 'all',
    code: 'forbidden',
  })
  expect(denied.frames.at(-1)).toMatchObject({
    type: 'result',
    ok: false,
    error: { code: 'forbidden' },
  })
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  c.send({ type: 'auth', grant: h.mintGrant({ caps: [] }) })
  await flush()
  c.frames.length = 0
  h.driver.emitTurn(laneId)
  await flush()
  expect(c.frames).toEqual([])
}

/** Grant admission, Host proof, renewal, revocation and read authority, in registration order. */
export const authScenarios = {
  authFirstFrame: scenario(
    'requires auth as the first frame and enforces its deadline',
    authFirstFrame,
  ),
  wrongGrantClaim: scenarioEach(
    ['signature', 'host', 'epoch', 'owner'] as const,
    'refuses a wrong %s',
    wrongGrantClaim,
  ),
  enrolledHostProof: scenario(
    'proves the enrolled Host, renews, rejects identity changes, and expires',
    enrolledHostProof,
  ),
  foreignHostHello: scenario(
    'refuses a correctly signed hello naming a different enrolled Host',
    foreignHostHello,
  ),
  revokedGrants: scenarioEach(
    ['session', 'client'] as const,
    'closes open sockets and rejects revoked %s grants',
    revokedGrants,
  ),
  readAuthority: scenario(
    'gates read operations and removes subscriptions when renewal drops read authority',
    readAuthority,
  ),
}
