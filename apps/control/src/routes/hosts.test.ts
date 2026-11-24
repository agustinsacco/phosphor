import { expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES as R,
  HOST_HEADERS,
  parseHostSelfResponse,
  parseHeartbeatResponse,
} from '@phosphor/shared/control-api'
import { userId } from '../test-support'
import { date, heartbeat, setup, routeContracts } from './__fixtures__/fixtures'

const routes = [
  {
    path: R.hostSelf,
    method: 'GET',
    mode: 'host',
    rpc: 'control_host_self',
    value: undefined,
    answer: {
      outcome: 'active',
      hostId: userId,
      label: 'bee',
      owner: { login: 'tester' },
      enrolledAt: date,
      lastSeenAt: null,
    },
    parser: parseHostSelfResponse,
    outcomes: { gone: 410 },
  },
  {
    path: R.hostHeartbeat,
    method: 'POST',
    mode: 'host',
    rpc: 'control_host_heartbeat',
    value: heartbeat,
    answer: { outcome: 'accepted' },
    parser: parseHeartbeatResponse,
    outcomes: { stale: 409, 'too-soon': 429, gone: 410 },
  },
  {
    path: R.hostRevoke,
    method: 'POST',
    mode: 'host',
    rpc: 'control_host_revoke_self',
    value: {},
    answer: { outcome: 'revoked' },
    parser: null,
    outcomes: { gone: 410 },
  },
] as const
routeContracts(routes)

it('rejects invalid revoke bodies and gone or malformed host keys', async () => {
  const s = setup()
  for (const value of [[], { extra: true }, ''])
    expect((await s.call(R.hostRevoke, 'POST', value, 'host')).status).toBe(400)
  s.results.control_host_key = { outcome: 'gone' }
  expect((await s.call(R.hostSelf, 'GET', undefined, 'host')).status).toBe(410)
  s.results.control_host_key = { outcome: 'active', publicKey: 'bad' }
  expect((await s.call(R.hostSelf, 'GET', undefined, 'host')).status).toBe(503)
})

it('claims each nonce in the database for twice the skew plus a second and refuses a replay', async () => {
  const s = setup()
  s.results.control_host_self = routes[0].answer
  const signed = s.key.request('GET', R.hostSelf, undefined, s.deps.clock(), userId)
  expect((await s.app.request(signed.clone())).status).toBe(200)
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_nonce_claim', {
    p_identity: userId,
    p_nonce: signed.headers.get(HOST_HEADERS.nonce),
    p_ttl_sec: 121,
  })
  expect((await s.app.request(signed.clone())).status).toBe(401)
  // Any other answer fails closed.
  const rpc = vi.mocked(s.deps.supabase.rpc)
  const answer = rpc.getMockImplementation()
  rpc.mockImplementation(async (name, args) =>
    name === 'control_nonce_claim' ? { outcome: 'too-many-requests' } : answer?.(name, args),
  )
  expect((await s.call(R.hostSelf, 'GET', undefined, 'host')).status).toBe(503)
})
