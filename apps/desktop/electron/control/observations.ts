import { machineStatus, type MachinesResponse } from '@shared/control-api'

export type TraceLog = (scope: string, message: string, data?: unknown) => void
const names = { up: 'online', down: 'offline', 'never-seen': 'never connected' } as const
/** Observations at fetch time only, not a second liveness monitor. */
export function machineObservations(log: TraceLog) {
  const seen = new Map<string, { label: string; status: string }>()
  return {
    clear: () => seen.clear(),
    observe(response: MachinesResponse, now: number, trace: string) {
      const present = new Set(response.machines.map((machine) => machine.id))
      for (const [hostId, old] of seen) {
        if (!present.has(hostId)) {
          log('machines', 'observed', {
            hostId,
            label: old.label,
            from: old.status,
            to: 'removed',
            trace,
            fetchReason: 'refresh',
          })
          seen.delete(hostId)
        }
      }
      const offset = Date.parse(response.serverTime) - now
      for (const machine of response.machines.slice(0, 1000)) {
        const status = names[machineStatus(machine, now, offset)]
        const previous = seen.get(machine.id)
        if (!previous || previous.status !== status)
          log('machines', 'observed', {
            hostId: machine.id,
            label: machine.label,
            from: previous?.status ?? null,
            to: status,
            lastSeenAt: machine.lastSeenAt,
            trace,
            fetchReason: 'refresh',
          })
        seen.set(machine.id, { label: machine.label, status })
      }
      while (seen.size > 1000) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
    },
  }
}
