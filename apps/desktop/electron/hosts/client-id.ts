import { normalizeLabel, isUuid } from '@shared/control-api'
import type { createControlClient } from '../control/client'

export type RemoteClients = Record<string, { clientId: string; label: string }>
export function cleanClients(raw: unknown): RemoteClients {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const clients: RemoteClients = {}
  const entries: [string, unknown][] = Object.entries(raw)
  for (const [user, value] of entries) {
    if (
      !isUuid(user) ||
      !value ||
      typeof value !== 'object' ||
      !('clientId' in value) ||
      !isUuid(value.clientId) ||
      !('label' in value) ||
      typeof value.label !== 'string' ||
      normalizeLabel(value.label) !== value.label
    )
      continue
    clients[user] = { clientId: value.clientId, label: value.label }
    const oldest = Object.keys(clients)[0]
    if (Object.keys(clients).length > 8 && oldest) delete clients[oldest]
  }
  return clients
}
export function createClientIds(ports: {
  user: () => string | null
  read: () => RemoteClients
  write: (clients: RemoteClients) => void
  hostname: () => string
  control: Pick<ReturnType<typeof createControlClient>, 'registerClient'>
}) {
  let generation = 0
  const flights = new Map<string, Promise<string>>()
  const replaced = new Set<string>()
  const replacing = new Map<string, Promise<boolean>>()
  async function get(): Promise<string> {
    const user = ports.user()
    if (!user) throw new Error('signed-out')
    const stored = cleanClients(ports.read())[user]
    if (stored) return stored.clientId
    const existing = flights.get(user)
    if (existing) return existing
    const epoch = generation
    const promise = (async () => {
      const clean = [...ports.hostname()].filter((c) => normalizeLabel(`x${c}x`) !== null).join('')
      const label = normalizeLabel(`Phosphor on ${clean}`.slice(0, 80)) ?? 'Phosphor'
      const result = await ports.control.registerClient(label)
      if (!result.ok) throw new Error(result.error.code)
      if (ports.user() !== user || generation !== epoch) throw new Error('signed-out')
      ports.write(
        cleanClients({
          ...ports.read(),
          [user]: { clientId: result.client.id, label: result.client.label },
        }),
      )
      return result.client.id
    })()
    flights.set(user, promise)
    try {
      return await promise
    } finally {
      if (flights.get(user) === promise) flights.delete(user)
    }
  }
  return {
    get,
    clear() {
      generation++
      flights.clear()
      replaced.clear()
      replacing.clear()
    },
    async replace() {
      const user = ports.user()
      if (!user) return false
      const flight = replacing.get(user)
      if (flight) return flight
      if (replaced.has(user)) return false
      replaced.add(user)
      const promise = (async () => {
        const clients = cleanClients(ports.read())
        delete clients[user]
        ports.write(clients)
        await get()
        return true
      })()
      replacing.set(user, promise)
      try {
        return await promise
      } finally {
        if (replacing.get(user) === promise) replacing.delete(user)
      }
    },
  }
}
