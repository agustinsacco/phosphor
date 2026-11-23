import { OWNER_METHODS } from '../../host-protocol-owner'
import { scenario, type ConformanceScenario } from '../conformance/context'
import { principalClaims, type ConformancePrincipal } from './ops'

/**
 * Owner methods are served only on a machine's local socket. Over a grant
 * connection every one is refused, whatever the Host's owner handlers would
 * answer an attested owner: none is ever `ok`.
 */
function ownerMethodsRefusedOverGrant(principal: ConformancePrincipal) {
  return scenario(
    'every owner method is refused over a grant connection',
    async ({ flush, expect, auth }) => {
      const c = await auth(principalClaims(principal))
      // One at a time: a Host bounds the calls a connection has in flight.
      for (const [index, method] of OWNER_METHODS.entries()) {
        const id = `owner-${index}`
        c.send({ type: 'call', id, method, params: {} })
        await flush()
        const answer = c.frames.find((f) => f.type === 'result' && f.id === id)
        expect(answer, method).toMatchObject({ type: 'result', ok: false })
        expect(['unsupported', 'forbidden', 'bad-request']).toContain(
          answer?.type === 'result' && !answer.ok ? answer.error.code : 'ok',
        )
      }
    },
  )
}

/** Scenarios for the machine's owner (Desktop) and its local socket. */
export function ownerScenarios(principal: ConformancePrincipal): ConformanceScenario[] {
  return [ownerMethodsRefusedOverGrant(principal)]
}
