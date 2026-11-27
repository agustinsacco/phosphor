import type { BrainApi, BrainService } from '@phosphor/brain-runtime/types'
import type { GuardedBrainService } from './runtime'

/** Throws unless this Host still owns its Brain and is not shutting down. */
export interface BrainOwnership {
  check(): void
}

const allowed = (ownership: BrainOwnership): boolean => {
  try {
    ownership.check()
    return true
  } catch {
    return false
  }
}

function checkedApi<T extends Partial<BrainApi>>(api: T, ownership: BrainOwnership): T {
  return Object.fromEntries(
    Object.entries(api).map(([name, call]) => [
      name,
      async (...args: unknown[]) => {
        ownership.check()
        return (call as (...args: unknown[]) => Promise<unknown>)(...args)
      },
    ]),
  ) as T
}

/**
 * The service as Host handlers see it: each call rechecks ownership first, so a write cannot
 * land after shutdown began or while a move owns the store. Launches never throw.
 */
export function guardBrainService(
  service: BrainService,
  ownership: BrainOwnership,
): GuardedBrainService {
  const api = checkedApi(service.api, ownership)
  return {
    api,
    // The surface's writer: ownership is checked again inside the write, beside the caller's check.
    guarded: (check) =>
      checkedApi(
        service.guarded((status, source) => {
          ownership.check()
          check(status, source)
        }),
        ownership,
      ),
    job(id) {
      ownership.check()
      return service.job(id)
    },
    async evidence(id, canReadSource) {
      ownership.check()
      return service.evidence(id, canReadSource)
    },
    async agent(method, request, signal) {
      ownership.check()
      return service.agent(method, request, signal)
    },
    forLane(lane) {
      const port = service.forLane(lane)
      return {
        async search(input) {
          ownership.check()
          return port.search(input)
        },
        async flag(input) {
          ownership.check()
          return port.flag(input)
        },
      }
    },
    recallLaunch: async () => (allowed(ownership) ? service.recallLaunch() : undefined),
    curatorLaunch: async () => (allowed(ownership) ? service.curatorLaunch() : undefined),
  }
}
