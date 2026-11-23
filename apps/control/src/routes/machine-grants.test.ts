import { readFileSync, readdirSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import {
  CONTROL_MACHINE_ROUTES as M,
  parseControlError,
  parseGrantIssueResponse,
  parseMachineDirectoryResponse,
} from '@phosphor/shared/control-api'
import { checkGrantClaims, splitGrant } from '@phosphor/shared/host-grant'
import { userId } from '../test-support'
import { date, routeContracts } from './__fixtures__/fixtures'
import { machineSetup } from './__fixtures__/machine-fixtures'
import { machineGrantClaims } from './machine-grant-claims'

routeContracts([
  {
    path: M.hostMachines,
    method: 'GET',
    mode: 'host',
    rpc: 'control_machine_directory',
    value: undefined,
    answer: {
      outcome: 'ok',
      serverTime: date,
      self: { id: userId, label: 'Alpha', machineReach: true },
      machines: [],
    },
    parser: parseMachineDirectoryResponse,
    outcomes: { gone: 410, 'account-disabled': 403 },
  },
])

const issue = (s: ReturnType<typeof machineSetup>, value: unknown = { targetHostId: s.targetId }) =>
  s.signed('POST', M.hostMachineGrants, value)

it('issues a machine grant with exactly the machine claims and no caps', async () => {
  const s = machineSetup()
  const res = await issue(s)
  expect(res.status).toBe(200)
  const response = parseGrantIssueResponse(await res.json())
  if (!response.ok) throw new Error('invalid grant response')
  expect(response.value.host).toEqual({
    id: s.targetId,
    endpoint: 'https://bravo.ts.net',
    publicKey: s.targetKey.publicKey,
  })
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_machine_grant_issue', {
    p_caller: s.callerId,
    p_target: s.targetId,
  })
  const payload = response.value.grant.split('.')[2]
  if (!payload) throw new Error('invalid token')
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  const iat = s.deps.clock() / 1000
  expect(decoded).toEqual({
    v: 1,
    iss: s.deps.config.publicOrigin,
    kid: 'current',
    sub: userId,
    sid: s.principal.sid,
    hostId: s.targetId,
    epoch: 3,
    client: { id: s.principal.id, label: 'Alpha' },
    caps: [],
    iat,
    exp: iat + 300,
    jti: expect.stringMatching(/^[0-9a-f]{16}$/),
    origin: 'machine',
    machine: s.callerId,
  })
  const split = splitGrant(response.value.grant)
  if (!split.ok) throw new Error('the Host parser refused the grant')
  expect(split.value.payload).toEqual(decoded)
  const expect3 = {
    iss: s.deps.config.publicOrigin,
    hostId: s.targetId,
    owner: userId,
    epoch: 3,
    revokedSessions: new Set<string>(),
    revokedClients: new Set<string>(),
  }
  expect(checkGrantClaims(split.value.payload, expect3, iat, 0)).toBe('machine-origin')
  expect(checkGrantClaims(split.value.payload, { ...expect3, machineOrigin: true }, iat, 0)).toBe(
    null,
  )
  expect(s.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'machine.grant_issued',
      hostId: s.callerId,
      targetHostId: s.targetId,
      clientId: s.principal.id,
    }),
  )
  expect(JSON.stringify(vi.mocked(s.deps.log).mock.calls)).not.toContain(response.value.grant)
})

it('freezes machine claims to an empty capability list without configure', () => {
  const claims = machineGrantClaims({
    origin: 'https://phosphor.test',
    kid: 'current',
    ownerId: userId,
    sid: userId,
    targetHostId: userId,
    callerHostId: userId,
    epoch: 1,
    client: { id: userId, label: 'Alpha' },
    iat: 1,
    jti: '0123456789abcdef',
  })
  expect(claims.caps).toEqual([])
  expect('configure' in claims).toBe(false)
  expect(claims.origin).toBe('machine')
})

it('maps every issue outcome to its own status', async () => {
  for (const [outcome, status] of [
    ['reach-off', 403],
    ['account-disabled', 403],
    ['not-found', 404],
    ['target-unavailable', 409],
    ['gone', 410],
    ['too-many-requests', 429],
    ['unexpected', 503],
  ] as const) {
    const s = machineSetup()
    s.results.control_machine_grant_issue = { outcome }
    const res = await issue(s)
    expect(res.status).toBe(status)
    expect(parseControlError(await res.json())).not.toBeNull()
  }
})

it('fails closed on database metadata it would sign', async () => {
  for (const change of [
    { epoch: 0 },
    { epoch: 2147483648 },
    { ownerId: 'owner' },
    { sid: null },
    { client: { id: userId, label: ' padded ' } },
    { endpoint: 'http://bravo.example' },
    { publicKey: 'short' },
  ]) {
    const s = machineSetup()
    s.results.control_machine_grant_issue = {
      ...(s.results.control_machine_grant_issue as object),
      ...change,
    }
    expect((await issue(s)).status).toBe(503)
  }
})

it('refuses malformed bodies, missing signing keys and unsigned callers', async () => {
  const s = machineSetup()
  for (const value of [{}, { targetHostId: 'bravo' }, []])
    expect((await issue(s, value)).status).toBe(400)
  const unsigned = await s.app.request(M.hostMachineGrants, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetHostId: s.targetId }),
  })
  expect(unsigned.status).toBe(401)
  const wrong = await s.app.request(M.hostMachineGrants, { method: 'GET' })
  expect(wrong.status).toBe(405)
  expect(wrong.headers.get('allow')).toBe('POST')
  s.deps.config = { ...s.deps.config, grantKeys: null }
  expect((await issue(s)).status).toBe(503)
})

it('names every control RPC so it matches the server pattern', () => {
  const root = new URL('../../../../', import.meta.url)
  const migration = readFileSync(
    new URL('supabase/migrations/20261122120000_control_machine_grants.sql', root),
    'utf8',
  )
  const created = [...migration.matchAll(/create function public\.([a-z_0-9]+)\(/g)].map(
    (match) => match[1],
  )
  expect(created).toEqual([
    'control_machine_beat',
    'control_machine_grant_issue',
    'control_machine_directory',
    'control_machine_reach_set',
    'control_machine_reach_list',
  ])
  const routes = new URL('apps/control/src/routes/', root)
  const called = readdirSync(routes)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => [
      ...readFileSync(new URL(file, routes), 'utf8').matchAll(/'(control_[^']*)'/g),
    ])
    .map((match) => match[1])
  for (const name of [...created, ...called]) expect(name).toMatch(/^control_[a-z_]{1,64}$/)
  for (const name of created) expect(called).toContain(name)
})
