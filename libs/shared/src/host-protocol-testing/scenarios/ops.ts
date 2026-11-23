import type { GrantPayload } from '../../host-grant'
import { scenario, type ConformanceScenario } from '../conformance/context'

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

/** Agent ops scenarios. The ops package adds its own here. */
export function opsScenarios(principal: ConformancePrincipal): ConformanceScenario[] {
  return [opsUnsupportedWithoutReadyOps(principal)]
}
