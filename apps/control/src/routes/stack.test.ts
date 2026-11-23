import { describe, expect, it } from 'vitest'
import {
  CONTROL_MACHINE_ROUTES as M,
  CONTROL_ROUTES as R,
  machineReachRoute,
  parseEnrollmentApproveResponse,
  parseGrantIssueResponse,
  parseHeartbeatResponse,
  parseMachineDirectoryResponse,
  parseMachineReachResponse,
  parseMachinesResponse,
  parseHostSelfResponse,
} from '@phosphor/shared/control-api'
import { splitGrant } from '@phosphor/shared/host-grant'
import { signingKey } from '../test-support'
import { parsed } from './shared'
import {
  enroll,
  signIn,
  signed,
  stackEnv,
  startStack,
  stopStack,
  userRequest,
  type Stack,
} from './__fixtures__/stack-harness'

const beat = {
  seq: 1,
  state: 'running',
  hostVersion: '2.0.0',
  uptimeSec: 1,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: 'https://bravo-stack.ts.net',
  machineGrants: true,
}

/** Two of one owner's machines: Alpha asks for a grant to Bravo, then the owner switches reach. */
async function machineReachFlow(stack: Stack) {
  const a = await signIn(stack, 'a')
  const alpha = signingKey()
  const bravo = signingKey()
  const alphaId = await enroll(stack, alpha, a.accessToken)
  const bravoId = await enroll(stack, bravo, a.accessToken)
  const issue = () =>
    signed(stack, alpha, M.hostMachineGrants, 'POST', { targetHostId: bravoId }, alphaId)
  expect((await issue()).status).toBe(409)
  const bravoBeat = await signed(stack, bravo, R.hostHeartbeat, 'POST', beat, bravoId)
  expect(parsed(parseHeartbeatResponse(await bravoBeat.json())).machineReach).toBe(true)
  const alphaBeat = { ...beat, endpoint: null }
  expect((await signed(stack, alpha, R.hostHeartbeat, 'POST', alphaBeat, alphaId)).status).toBe(200)
  const listed = await signed(stack, alpha, M.hostMachines, 'GET', undefined, alphaId)
  const directory = parsed(parseMachineDirectoryResponse(await listed.json()))
  expect(directory.self).toEqual({ id: alphaId, label: 'Bee test', machineReach: true })
  expect(directory.machines).toMatchObject([
    { id: bravoId, machineGrants: true, machineReach: true, reachable: true },
  ])
  const granted = await issue()
  expect(granted.status).toBe(200)
  const grant = parsed(parseGrantIssueResponse(await granted.json()))
  expect(grant.host).toMatchObject({ id: bravoId, endpoint: beat.endpoint })
  const split = splitGrant(grant.grant)
  if (!split.ok) throw new Error('the Host parser refused the grant')
  expect(split.value.payload).toMatchObject({ caps: [], origin: 'machine', machine: alphaId })
  const machines = parsed(
    parseMachinesResponse(await (await userRequest(stack, a.accessToken, R.machines)).json()),
  )
  expect(machines.machines.every((machine) => machine.machineReach === true)).toBe(true)
  const off = await userRequest(stack, a.accessToken, machineReachRoute(alphaId), 'PATCH', {
    enabled: false,
  })
  expect(parsed(parseMachineReachResponse(await off.json()))).toEqual({ machineReach: false })
  expect((await issue()).status).toBe(403)
  // A stopping beat is accepted at once; its reply lists the revoked principal.
  const stopping = { ...beat, seq: 2, state: 'stopping' }
  const next = await signed(stack, bravo, R.hostHeartbeat, 'POST', stopping, bravoId)
  const revoked = parsed(parseHeartbeatResponse(await next.json())).revoked
  expect(revoked?.clients).toContain(split.value.payload.client.id)
  expect(revoked?.sessions).not.toContain(split.value.payload.sid)
  const on = { enabled: true }
  const back = await userRequest(stack, a.accessToken, machineReachRoute(alphaId), 'PATCH', on)
  expect(back.status).toBe(200)
  expect((await issue()).status).toBe(409)
}

describe.runIf(stackEnv.url && stackEnv.secret)(
  'control API against the isolated Supabase stack',
  () => {
    it('enrolls, isolates owners, beats, revokes and rejects a signed-out session', async () => {
      const stack = await startStack()
      try {
        const a = await signIn(stack, 'a')
        const b = await signIn(stack, 'b')
        expect(a.user.id === b.user.id).toBe(false)
        const signer = signingKey()
        const id = await enroll(stack, signer, a.accessToken)
        const self = await signed(stack, signer, R.hostSelf, 'GET', undefined, id)
        expect(self.status).toBe(200)
        expect(parseHostSelfResponse(await self.json()).ok).toBe(true)
        const heartbeat = {
          seq: 1,
          state: 'running',
          hostVersion: '2.0.0',
          uptimeSec: 42,
          readiness: { pi: 'ok', claude: 'missing', tailscale: 'ok' },
          lanes: { running: 2, waiting: 1 },
          endpoint: null,
        }
        expect((await signed(stack, signer, R.hostHeartbeat, 'POST', heartbeat, id)).status).toBe(
          200,
        )
        expect((await signed(stack, signer, R.hostHeartbeat, 'POST', heartbeat, id)).status).toBe(
          409,
        )
        expect(
          (await signed(stack, signer, R.hostHeartbeat, 'POST', { ...heartbeat, seq: 2 }, id))
            .status,
        ).toBe(429)
        expect(
          (
            await signed(
              stack,
              signer,
              R.hostHeartbeat,
              'POST',
              { ...heartbeat, seq: 2, state: 'stopping' },
              id,
            )
          ).status,
        ).toBe(200)
        const machinesA = parsed(
          parseMachinesResponse(await (await userRequest(stack, a.accessToken, R.machines)).json()),
        )
        expect(machinesA.machines).toHaveLength(1)
        expect(machinesA.machines[0]).toMatchObject({
          id,
          hostVersion: '2.0.0',
          state: 'stopping',
          readiness: heartbeat.readiness,
          lanes: heartbeat.lanes,
        })
        expect(machinesA.machines[0]?.lastSeenAt).not.toBeNull()
        expect(
          parsed(
            parseMachinesResponse(
              await (await userRequest(stack, b.accessToken, R.machines)).json(),
            ),
          ).machines,
        ).toHaveLength(0)
        for (const method of ['PATCH', 'DELETE'])
          expect(
            (
              await userRequest(
                stack,
                b.accessToken,
                R.machines + '/' + id,
                method,
                method === 'PATCH' ? { label: 'No' } : undefined,
              )
            ).status,
          ).toBe(404)
        const renamed = await userRequest(stack, a.accessToken, R.machines + '/' + id, 'PATCH', {
          label: 'Renamed',
        })
        expect(renamed.status).toBe(200)
        expect(parsed(parseEnrollmentApproveResponse(await renamed.json())).machine.label).toBe(
          'Renamed',
        )
        const removed = await userRequest(stack, a.accessToken, R.machines + '/' + id, 'DELETE')
        expect(removed.status).toBe(204)
        expect(await removed.text()).toBe('')
        expect((await signed(stack, signer, R.hostSelf, 'GET', undefined, id)).status).toBe(410)
        const second = signingKey()
        const id2 = await enroll(stack, second, a.accessToken)
        const revoked = await signed(stack, second, R.hostRevoke, 'POST', {}, id2)
        expect(revoked.status).toBe(204)
        expect(await revoked.text()).toBe('')
        expect((await signed(stack, second, R.hostRevoke, 'POST', {}, id2)).status).toBe(410)
        // Two creates above, then eight more. The eleventh is limited before auth.
        for (let i = 0; i < 8; i++) {
          const fresh = signingKey()
          expect(
            (
              await signed(stack, fresh, R.enrollments, 'POST', {
                publicKey: fresh.publicKey,
                hostname: 'limit-test',
                platform: 'linux',
                arch: 'x64',
                hostVersion: '1.0.0',
              })
            ).status,
          ).toBe(200)
        }
        expect(
          (
            await fetch(stack.origin + R.enrollments, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          ).status,
        ).toBe(429)
        await stack.auth.revoke(a.accessToken)
        expect(
          (
            await stack
              .app()
              .request(R.machines, { headers: { authorization: `Bearer ${a.accessToken}` } })
          ).status,
        ).toBe(401)
        expect(stack.counters.rpc).toBeGreaterThan(0)
      } finally {
        await stopStack(stack)
      }
    })
    it('issues machine grants, lists siblings and switches reach', async () => {
      const stack = await startStack()
      try {
        await machineReachFlow(stack)
      } finally {
        await stopStack(stack)
      }
    })
  },
)
