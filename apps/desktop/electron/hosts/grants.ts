import type { GrantIssueResponse } from '@shared/control-api'
import type { DesktopControlErrorCode } from '@shared/ipc'
import { HOST_LIMITS } from '@shared/host-protocol'
import type { createControlClient } from '../control/client'
import type { createClientIds } from './client-id'
import type { createConfigureHosts } from './configure-hosts'

interface GrantPorts {
  control: Pick<ReturnType<typeof createControlClient>, 'grant'>
  clients: ReturnType<typeof createClientIds>
  present: (hostId: string) => boolean
  /** Persisted per account; a full `clear()` (account change, quit) leaves it alone. */
  configured: Pick<ReturnType<typeof createConfigureHosts>, 'has' | 'set'>
  now?: () => number
}
function grantFailure(code: DesktopControlErrorCode): Error {
  return new Error(
    code === 'not-found' ? 'grant-refused' : code === 'forbidden' ? 'account-disabled' : code,
  )
}

export function createGrants(ports: GrantPorts) {
  const cache = new Map<string, GrantIssueResponse>()
  const flights = new Map<
    string,
    { promise: Promise<GrantIssueResponse>; token: { valid: boolean } }
  >()
  let generation = 0
  return {
    /** Explicitly requested from this machine's Settings page; forgotten on sign-out. */
    configure(hostId: string, enabled = true) {
      if (enabled && !ports.present(hostId)) throw new Error('grant-refused')
      ports.configured.set(hostId, enabled)
      this.clear(hostId)
    },
    clear(hostId?: string) {
      if (!hostId) generation++
      if (hostId) {
        cache.delete(hostId)
        const flight = flights.get(hostId)
        if (flight) flight.token.valid = false
        flights.delete(hostId)
      } else {
        cache.clear()
        flights.clear()
        ports.clients.clear()
      }
    },
    grantFor(hostId: string): Promise<GrantIssueResponse> {
      const saved = cache.get(hostId)
      if (
        saved &&
        Date.parse(saved.expiresAt) - HOST_LIMITS.renewBeforeSec * 1000 > (ports.now ?? Date.now)()
      )
        return Promise.resolve(saved)
      const flight = flights.get(hostId)
      if (flight) return flight.promise
      if (!ports.present(hostId) || flights.size >= 32)
        return Promise.reject(new Error('grant-refused'))
      const epoch = generation
      const active = { valid: true }
      const promise = (async () => {
        const issue = async () =>
          ports.configured.has(hostId)
            ? ports.control.grant(hostId, await ports.clients.get(), true)
            : ports.control.grant(hostId, await ports.clients.get())
        let result = await issue()
        if (
          !result.ok &&
          result.error.code === 'not-found' &&
          epoch === generation &&
          active.valid &&
          ports.present(hostId) &&
          (await ports.clients.replace())
        )
          result = await issue()
        if (epoch !== generation || !active.valid || !ports.present(hostId))
          throw new Error('signed-out')
        if (!result.ok) throw grantFailure(result.error.code)
        if (result.host.id !== hostId) throw new Error('grant-refused')
        cache.set(hostId, result)
        if (cache.size > 32) {
          const oldest = cache.keys().next().value
          if (oldest) cache.delete(oldest)
        }
        return result
      })()
      const flightEntry = { promise, token: active }
      flights.set(hostId, flightEntry)
      void promise
        .finally(() => {
          if (flights.get(hostId) === flightEntry) flights.delete(hostId)
        })
        .catch(() => {})
      return promise
    },
  }
}
