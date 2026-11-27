import { HOST_LIMITS } from '@phosphor/shared/host-protocol'

interface GrantCachePorts<Reply, Grant extends { expiresAt: string }, Options> {
  now?: () => number
  present(hostId: string): boolean
  issue(hostId: string, current: () => boolean, options?: Options): Promise<Reply>
  readGrant(hostId: string, reply: Reply): Grant
}

/** Per target, single-flight until invalidated and reusable only outside the renewal margin. */
export function createGrantCache<Reply, Grant extends { expiresAt: string }, Options = undefined>(
  ports: GrantCachePorts<Reply, Grant, Options>,
) {
  const cache = new Map<string, Grant>()
  const flights = new Map<string, { promise: Promise<Grant>; token: { valid: boolean } }>()
  let generation = 0

  function clear(hostId?: string) {
    if (!hostId) {
      generation++
      cache.clear()
      flights.clear()
      return
    }
    cache.delete(hostId)
    const flight = flights.get(hostId)
    if (flight) flight.token.valid = false
    flights.delete(hostId)
  }

  function grantFor(hostId: string, options?: Options): Promise<Grant> {
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
    const current = () => epoch === generation && active.valid && ports.present(hostId)
    const promise = (async () => {
      const reply = await ports.issue(hostId, current, options)
      if (!current()) throw new Error('signed-out')
      const grant = ports.readGrant(hostId, reply)
      cache.set(hostId, grant)
      if (cache.size > 32) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
      }
      return grant
    })()
    const entry = { token: active, promise }
    flights.set(hostId, entry)
    void promise
      .finally(() => {
        if (flights.get(hostId) === entry) flights.delete(hostId)
      })
      .catch(() => {})
    return promise
  }

  return { grantFor, clear }
}
