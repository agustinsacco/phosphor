import type { GrantPayload } from '../../host-grant'
import type { HostFrame } from '../../host-protocol'
import { challenge, type ConformanceViewer } from '../conformance/client'
import { scenario, type ConformanceKit, type ConformanceScenario } from '../conformance/context'

/** Which grant a scenario's connection presents. `machine` is another enrolled machine's agent. */
export type ConformancePrincipal = 'user' | 'machine'

export const MACHINE_CONFORMANCE_ID = '00000000-0000-4000-8000-0000000000aa'

/** The grant claims a principal's connection is minted with. */
export function principalClaims(principal: ConformancePrincipal): Partial<GrantPayload> {
  return principal === 'machine'
    ? { origin: 'machine', machine: MACHINE_CONFORMANCE_ID, caps: [] }
    : {}
}

/** A Host that does not announce `ready.ops` answers both forms of `ops.run` `unsupported`. */
function opsUnsupportedWithoutReadyOps(principal: ConformancePrincipal) {
  return scenario(
    'ops.run without ready.ops answers unsupported',
    async ({ h, flush, expect, auth, receipts }, t) => {
      const c = await auth(principalClaims(principal))
      const ready = c.frames[0]
      if (ready?.type === 'ready' && ready.ops === true) t.skip('the Host serves ops')
      const request = { op: 'lane.list', args: {} }
      c.send({ type: 'call', id: 'ops', method: 'ops.run', params: request })
      const requestId = h.requestId()
      c.send({ type: 'command', requestId, op: { type: 'ops.run', ...request } })
      await flush()
      expect(c.frames).toContainEqual({
        type: 'result',
        id: 'ops',
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      })
      expect(receipts(c, requestId)).toEqual([
        { requestId, status: 'rejected', code: 'unsupported' },
      ])
    },
  )
}

type Skip = { skip(note?: string): void }

/** A connection on a Host that announces `ready.ops`; the scenario is skipped on one that does not. */
async function servingOps(kit: ConformanceKit, t: Skip, claims: Partial<GrantPayload>) {
  const c = await kit.auth(claims)
  const ready = c.frames[0]
  if (ready?.type !== 'ready' || ready.ops !== true) t.skip('the Host does not serve ops')
  return c
}

/** The `ops.run` call's answer: the in-band result, or the frame-level error. */
async function opsCall(kit: ConformanceKit, c: ConformanceViewer, params: unknown) {
  const id = kit.h.requestId()
  c.send({ type: 'call', id, method: 'ops.run', params })
  await kit.flush()
  const found = c.frames.find(
    (f): f is Extract<HostFrame, { type: 'result' }> => f.type === 'result' && f.id === id,
  )
  return found?.ok ? (found.data as Record<string, unknown>) : { frame: found }
}

function opsCallAndCommand(principal: ConformancePrincipal) {
  return scenario('ops.run answers in band as a call and as a command', async (kit, t) => {
    const c = await servingOps(kit, t, principalClaims(principal))
    kit.expect(await opsCall(kit, c, { op: 'whoami', args: {} })).toMatchObject({ status: 'ok' })
    const requestId = kit.h.requestId()
    c.send({ type: 'command', requestId, op: { type: 'ops.run', op: 'help', args: {} } })
    await kit.flush()
    kit
      .expect(kit.receipts(c, requestId))
      .toEqual([{ requestId, status: 'done', data: kit.expect.objectContaining({ status: 'ok' }) }])
  })
}

function unknownOpUnsupported(principal: ConformancePrincipal) {
  return scenario('an unknown op is denied unsupported in band', async (kit, t) => {
    const c = await servingOps(kit, t, principalClaims(principal))
    kit.expect(await opsCall(kit, c, { op: 'no.such', args: {} })).toMatchObject({
      status: 'denied',
      code: 'unsupported',
    })
  })
}

/**
 * Another machine's agent asks; the user approves the exact ask; the agent's
 * resubmission runs once. Skipped on a Host that admits no machine grants or
 * whose policy does not ask for `whoami` from another machine.
 */
function confirmApproveResubmit() {
  return scenario(
    'an asked op runs once after confirm, confirm.approve and resubmit',
    async (kit, t) => {
      const user = await servingOps(kit, t, {})
      const machine = kit.client()
      machine.send({ type: 'auth', grant: kit.h.mintGrant(principalClaims('machine')), challenge })
      await kit.flush()
      if (machine.frames[0]?.type !== 'ready') t.skip('the Host admits no machine grants')
      const request = { op: 'whoami', args: {}, reason: 'Check which machine this is.' }
      const asked = await opsCall(kit, machine, request)
      if (asked?.status !== 'confirm') t.skip('the Host’s policy does not ask for whoami')
      const confirm = { confirmId: asked?.confirmId, digest: asked?.digest }
      kit.expect(await opsCall(kit, machine, { ...request, confirm })).toMatchObject({
        status: 'denied',
      })
      const approve = { op: 'confirm.approve', args: { confirmId: confirm.confirmId } }
      kit.expect(await opsCall(kit, user, approve)).toMatchObject({ status: 'ok' })
      kit.expect(await opsCall(kit, machine, { ...request, confirm })).toMatchObject({
        status: 'ok',
      })
      kit.expect(await opsCall(kit, machine, { ...request, confirm })).toMatchObject({
        status: 'denied',
      })
    },
  )
}

/** Agent ops scenarios. The ops package adds its own here. */
export function opsScenarios(principal: ConformancePrincipal): ConformanceScenario[] {
  return [
    opsUnsupportedWithoutReadyOps(principal),
    opsCallAndCommand(principal),
    unknownOpUnsupported(principal),
    confirmApproveResubmit(),
  ]
}
