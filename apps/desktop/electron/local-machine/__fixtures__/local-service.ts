import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { HostConnectionSnapshot } from '@phosphor/host-client/connection'
import type { LeaseRefusal } from '@phosphor/shared/host-protocol-owner'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import type { SameMachineConnection } from '../same-machine'

type Result = Extract<HostFrame, { type: 'result' }>

/**
 * A stand-in for This Mac's service as Desktop main sees it: a projection
 * and owner lease calls. A lease is refused over a live lane's folder or
 * another held lease, as the service's own `WorkspaceLeases` does.
 */
export interface FakeLocalService {
  hostId: string
  state: HostConnectionSnapshot['state']
  repositories: { id: string; path: string }[]
  lanes: {
    laneId: string
    cwd: string
    activity: HostConnectionSnapshot['lanes'][number]['activity']
  }[]
  leases: Map<string, string[]>
  /** Forces the next take to be refused with this reason. */
  refuse?: LeaseRefusal
  /** Makes renew answer `{ ok: false }`. */
  lost: boolean
  calls: { method: string; params: unknown }[]
  connection: SameMachineConnection
}

const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`)

function ok(id: string, data: unknown): Result {
  return { type: 'result', id, ok: true, data } as Result
}

export function fakeLocalService(hostId = 'mac-0001'): FakeLocalService {
  let next = 0
  const service: FakeLocalService = {
    hostId,
    state: 'ready',
    repositories: [],
    lanes: [],
    leases: new Map(),
    lost: false,
    calls: [],
    connection: {
      snapshot: () =>
        ({
          state: service.state,
          repositories: service.repositories.map((r) => ({ ...r, name: r.id })),
          lanes: service.lanes.map((l) => ({ ...l, repositoryId: 'r' })),
        }) as unknown as HostConnectionSnapshot,
      call: vi.fn(async (method: string, params?: unknown): Promise<Result> => {
        service.calls.push({ method, params })
        const id = String(next++)
        if (method === 'owner.lease.take') {
          const { paths } = params as { paths: string[] }
          for (const path of paths) {
            if (service.refuse) return ok(id, { refused: service.refuse, path })
            const live = service.lanes.some((l) => l.activity !== 'stopped' && inside(path, l.cwd))
            if (live) return ok(id, { refused: 'live-lane', path })
            for (const held of service.leases.values())
              if (held.some((p) => inside(p, path) || inside(path, p)))
                return ok(id, { refused: 'busy', path })
          }
          const leaseId = randomUUID()
          service.leases.set(leaseId, paths)
          return ok(id, { leaseId })
        }
        if (method === 'owner.lease.renew') return ok(id, { ok: !service.lost })
        if (method === 'owner.lease.release') {
          service.leases.delete((params as { leaseId: string }).leaseId)
          return ok(id, { ok: true })
        }
        return {
          type: 'result',
          id,
          ok: false,
          error: { code: 'unsupported', message: method },
        } as Result
      }),
    },
  }
  return service
}
