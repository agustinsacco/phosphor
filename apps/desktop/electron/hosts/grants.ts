import type { GrantIssueResponse } from '@shared/control-api'
import { HOST_LIMITS } from '@shared/host-protocol'
import type { createControlClient } from '../control/client'
import type { createClientIds } from './client-id'

export function createGrants(ports: {
  control: Pick<ReturnType<typeof createControlClient>, 'grant'>
  clients: ReturnType<typeof createClientIds>
  present: (hostId: string) => boolean
  now?: () => number
}) {
  const cache = new Map<string, GrantIssueResponse>()
  const flights = new Map<
    string,
    { promise: Promise<GrantIssueResponse>; token: { valid: boolean } }
  >()
  let generation = 0
  return {
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
        let result = await ports.control.grant(hostId, await ports.clients.get())
        if (
          !result.ok &&
          result.error.code === 'not-found' &&
          epoch === generation &&
          active.valid &&
          ports.present(hostId) &&
          (await ports.clients.replace())
        )
          result = await ports.control.grant(hostId, await ports.clients.get())
        if (epoch !== generation || !active.valid || !ports.present(hostId))
          throw new Error('signed-out')
        if (!result.ok)
          throw new Error(
            result.error.code === 'not-found'
              ? 'grant-refused'
              : result.error.code === 'forbidden'
                ? 'account-disabled'
                : result.error.code,
          )
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
