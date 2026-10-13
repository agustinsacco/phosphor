import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES as R,
  parseGrantIssueResponse,
  parseHeartbeatResponse,
  isPublicKey,
} from '@phosphor/shared/control-api'
import { HOST_CAPABILITIES } from '@phosphor/shared/remote-host'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { dependencies, signingKey, userId } from '../test-support'

function setup() {
  const deps = dependencies()
  const seed = randomBytes(32).toString('base64url')
  deps.config = parseConfig({
    SUPABASE_SECRET_KEY: randomBytes(32).toString('hex'),
    CONTROL_GRANT_KEYS: `current=${seed}`,
  })
  const hostId = randomUUID(),
    clientId = randomUUID(),
    sid = randomUUID()
  const hostKey = signingKey()
  const results: Record<string, unknown> = {
    control_account: { enabled: true, maxHosts: 20 },
    control_client_register: { outcome: 'registered', client: { id: clientId, label: 'Desktop' } },
    control_client_revoke: { outcome: 'revoked' },
    control_grant_issue: {
      outcome: 'issued',
      epoch: 2,
      publicKey: hostKey.publicKey,
      endpoint: 'https://bee.ts.net',
      client: { id: clientId, label: 'Desktop' },
    },
    control_host_key: { outcome: 'active', publicKey: hostKey.publicKey },
    control_host_heartbeat: { outcome: 'accepted' },
    control_host_revocations: {
      epoch: 2,
      ownerId: userId,
      revoked: { sessions: [sid], clients: [clientId] },
    },
  }
  vi.mocked(deps.supabase.rpc).mockImplementation(async (name) => results[name])
  const app = createApp(deps)
  const token = (session: unknown = sid) =>
    `e30.${Buffer.from(JSON.stringify({ exp: deps.clock() / 1000 + 600, aud: 'authenticated', session_id: session })).toString('base64url')}.c2ln`
  const call = (path: string, body?: unknown, method = 'POST', session: unknown = sid) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token(session)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { deps, seed, hostId, hostKey, clientId, sid, results, app, call, token }
}
it('issues exactly the signed claims and publishes the matching public key, never secrets in logs', async () => {
  const s = setup()
  const res = await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId, ignored: 'unknown' })
  expect(res.status).toBe(200)
  const parsed = parseGrantIssueResponse(await res.json())
  if (!parsed.ok) throw new Error('invalid grant response')
  const value = parsed.value
  expect(value.host).toEqual({
    id: s.hostId,
    endpoint: 'https://bee.ts.net',
    publicKey: s.hostKey.publicKey,
  })
  const [prefix, version, payload, signature] = value.grant.split('.')
  expect([prefix, version]).toEqual(['phosphor-grant', 'v1'])
  if (!payload || !signature) throw new Error('invalid token')
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  const iat = s.deps.clock() / 1000
  expect(decoded).toEqual({
    v: 1,
    iss: s.deps.config.publicOrigin,
    kid: 'current',
    sub: userId,
    sid: s.sid,
    hostId: s.hostId,
    epoch: 2,
    client: { id: s.clientId, label: 'Desktop' },
    caps: HOST_CAPABILITIES,
    iat,
    exp: iat + 300,
    jti: expect.stringMatching(/^[0-9a-f]{16}$/),
  })
  expect(value.expiresAt).toBe(new Date((iat + 300) * 1000).toISOString())
  const publicRes = await s.app.request(R.grantKeys)
  expect(publicRes.status).toBe(200)
  expect(publicRes.headers.get('cache-control')).toBe('public, max-age=300')
  const keyset: unknown = await publicRes.json()
  expect(keyset).toEqual(s.deps.config.grantKeys?.keyset)
  const key = s.deps.config.grantKeys?.keyset.keys[0]
  if (!key) throw new Error('missing key')
  expect(Object.keys(key).sort()).toEqual(['kid', 'publicKey'])
  expect(isPublicKey(key.publicKey)).toBe(true)
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(key.publicKey, 'base64url'),
    ]),
    format: 'der',
    type: 'spki',
  })
  expect(
    verify(null, Buffer.from(payload, 'base64url'), publicKey, Buffer.from(signature, 'base64url')),
  ).toBe(true)
  expect(
    verify(
      null,
      Buffer.from(payload + 'x', 'base64url'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(false)
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_grant_issue', {
    p_user: userId,
    p_host: s.hostId,
    p_client: s.clientId,
    p_sid: s.sid,
  })
  expect(s.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'grant.issued',
      userId,
      hostId: s.hostId,
      clientId: s.clientId,
      exp: iat + 300,
    }),
  )
  const logs = JSON.stringify(vi.mocked(s.deps.log).mock.calls)
  for (const secret of [s.seed, value.grant, signature, payload, s.sid, s.token(), key.publicKey])
    expect(logs).not.toContain(secret)
})
it('registers Desktop clients, revokes only through the owner RPC, and emits identity-only events', async () => {
  const s = setup()
  const registered = await s.call(R.clients, { label: ' Desktop ', ignored: 'discarded' })
  expect(registered.status).toBe(200)
  expect(await registered.json()).toEqual({ client: { id: s.clientId, label: 'Desktop' } })
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_client_register', {
    p_user: userId,
    p_label: 'Desktop',
    p_kind: 'desktop',
  })
  const revoked = await s.call(R.clients + '/' + s.clientId, undefined, 'DELETE')
  expect(revoked.status).toBe(204)
  expect(await revoked.text()).toBe('')
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_client_revoke', {
    p_user: userId,
    p_client: s.clientId,
  })
  for (const event of ['client.registered', 'client.revoked'])
    expect(s.deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ event, userId, clientId: s.clientId }),
    )
  expect((await s.call(R.clients + '/bad', undefined, 'DELETE')).status).toBe(400)
  s.results.control_client_revoke = { outcome: 'not-found' }
  expect((await s.call(R.clients + '/' + s.clientId, undefined, 'DELETE')).status).toBe(404)
  s.results.control_client_register = { outcome: 'too-many-requests' }
  expect((await s.call(R.clients, { label: 'Desktop' })).status).toBe(429)
})
it('fails closed on malformed input, missing verified session id, upstream denial and unavailable keys', async () => {
  const s = setup()
  for (const value of [
    null,
    [],
    {},
    { hostId: 'bad', clientId: s.clientId },
    { hostId: s.hostId, clientId: 'bad' },
  ])
    expect((await s.call(R.grants, value)).status).toBe(400)
  for (const value of [
    null,
    [],
    {},
    { label: '' },
    { label: 'x'.repeat(81) },
    { label: 'bad\u2028label' },
  ])
    expect((await s.call(R.clients, value)).status).toBe(400)
  for (const sid of [null, '', 'bad', 123, {}])
    expect(
      (await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId }, 'POST', sid)).status,
    ).toBe(401)
  const noSid = `e30.${Buffer.from(JSON.stringify({ exp: s.deps.clock() / 1000 + 600, aud: 'authenticated' })).toString('base64url')}.c2ln`
  expect(
    (
      await s.app.request(R.grants, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${noSid}` },
        body: JSON.stringify({ hostId: s.hostId, clientId: s.clientId }),
      })
    ).status,
  ).toBe(401)
  expect(s.deps.supabase.rpc).not.toHaveBeenCalledWith('control_grant_issue', expect.anything())
  const valid = s.results.control_grant_issue
  if (!valid || typeof valid !== 'object') throw new Error('missing metadata')
  s.results.control_grant_issue = { outcome: 'not-found' }
  expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(404)
  for (const value of [
    null,
    { outcome: 'unexpected' },
    ...[0, 1.5, 2147483648, '2'].map((epoch) => ({ ...valid, epoch })),
    { ...valid, client: { id: randomUUID(), label: 'Desktop' } },
    { ...valid, client: { id: s.clientId, label: ' Desktop ' } },
    { ...valid, publicKey: 'bad' },
    { ...valid, endpoint: 'http://evil.test' },
  ]) {
    s.results.control_grant_issue = value
    expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(503)
  }
  s.deps.config = parseConfig({ SUPABASE_SECRET_KEY: randomBytes(32).toString('hex') })
  expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(503)
  expect((await s.app.request(R.grantKeys)).status).toBe(503)
  expect((await s.call(R.clients, { label: 'Desktop' })).status).toBe(200)
})
it('runs user verification and the suspension check before reading session claims', async () => {
  const s = setup()
  vi.mocked(s.deps.supabase.getUser).mockRejectedValueOnce(new Error('private auth failure'))
  expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(500)
  s.results.control_account = { enabled: false, maxHosts: 20 }
  expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(403)
  expect(s.deps.supabase.rpc).not.toHaveBeenCalledWith('control_grant_issue', expect.anything())
  expect(JSON.stringify(vi.mocked(s.deps.log).mock.calls)).not.toContain('private auth failure')
})
it('enforces exact per-user issue and registration limits', async () => {
  const s = setup()
  for (let i = 0; i < 120; i++)
    expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(200)
  expect((await s.call(R.grants, { hostId: s.hostId, clientId: s.clientId })).status).toBe(429)
  for (let i = 0; i < 10; i++)
    expect((await s.call(R.clients, { label: 'Desktop' })).status).toBe(200)
  expect((await s.call(R.clients, { label: 'Desktop' })).status).toBe(429)
})
it('delivers bounded revocations on heartbeat and keeps accepted beats on revocation failures', async () => {
  const s = setup()
  const heartbeat = {
    seq: 1,
    state: 'running',
    hostVersion: '1.0.0',
    uptimeSec: 1,
    readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
    lanes: { running: 0, waiting: 0 },
    endpoint: null,
  }
  const call = () =>
    s.app.request(s.hostKey.request('POST', R.hostHeartbeat, heartbeat, s.deps.clock(), s.hostId))
  const res = await call()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    accepted: true,
    nextInSec: 30,
    epoch: 2,
    ownerId: userId,
    revoked: { sessions: [s.sid], clients: [s.clientId] },
  })
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_host_revocations', { p_host: s.hostId })
  for (const invalid of [
    null,
    { epoch: 0 },
    { epoch: 2, ownerId: userId, revoked: { sessions: Array(101).fill(s.sid), clients: [] } },
  ]) {
    s.results.control_host_revocations = invalid
    const fallback = await call()
    expect(fallback.status).toBe(200)
    expect(await fallback.json()).toEqual({ accepted: true, nextInSec: 30 })
  }
  vi.mocked(s.deps.supabase.rpc).mockImplementation(async (name) => {
    if (name === 'control_host_revocations') throw new Error(s.seed)
    return s.results[name]
  })
  const fallback = await call()
  expect(parseHeartbeatResponse(await fallback.json())).toEqual({
    ok: true,
    value: { accepted: true, nextInSec: 30 },
  })
  expect(s.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'heartbeat.revocations_unavailable',
      hostId: s.hostId,
      reason: 'unavailable',
    }),
  )
  expect(JSON.stringify(vi.mocked(s.deps.log).mock.calls)).not.toContain(s.seed)
})
