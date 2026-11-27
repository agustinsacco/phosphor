import type { BrainStatus } from '@phosphor/shared/brain'
import type { BrainSavedSource } from '@phosphor/brain-runtime/types'
import { isUuid } from '@phosphor/shared/control-api'
import type { BrainSurfaceAuthority, BrainSurfaceOutcome } from '../api/brain-adapter'
import type { BrainInventoryLane, BrainSurfaceInventory } from './surface-service'

type Refusal = Exclude<BrainSurfaceOutcome['status'], 'ok'>
export class Refused extends Error {
  constructor(readonly status: Refusal) {
    super(status)
  }
}
export function refuse(status: Refusal): never {
  throw new Refused(status)
}
export function checkCaller(caller: BrainSurfaceAuthority) {
  if (!caller.admit()) refuse('unavailable')
}

export class LaneScope {
  constructor(
    readonly inventory: BrainSurfaceInventory,
    readonly caller: BrainSurfaceAuthority,
  ) {}

  lane(laneId: string): BrainInventoryLane {
    checkCaller(this.caller)
    const lane = this.inventory.lane(laneId, this.caller)
    if (!lane || lane.laneId !== laneId || !lane.sessionPath || !lane.sessionId) refuse('not-found')
    return {
      laneId: lane.laneId,
      sessionId: lane.sessionId,
      sessionPath: lane.sessionPath,
      title: lane.title,
    }
  }

  source(source: BrainSavedSource): BrainInventoryLane | undefined {
    if (!this.caller.admit()) return undefined
    const lane = this.inventory.source(source, this.caller)
    if (!lane || !isUuid(lane.laneId)) return undefined
    const visible = this.inventory.lane(lane.laneId, this.caller)
    return visible?.laneId === lane.laneId &&
      visible.sessionId === source.sessionId &&
      visible.sessionPath === source.sessionPath
      ? visible
      : undefined
  }

  check(lane: BrainInventoryLane, source?: BrainSavedSource) {
    const current = this.lane(lane.laneId)
    if (
      current.sessionId !== lane.sessionId ||
      current.sessionPath !== lane.sessionPath ||
      (source && (source.sessionPath !== lane.sessionPath || source.sessionId !== lane.sessionId))
    )
      refuse('not-found')
  }
}

/** Saved Desktop titles can be first-prompt excerpts, not owner-assigned lane names. */
export function visibleJobs<T extends BrainStatus>(status: T, scopes: LaneScope): T {
  const labels = new Map<string, string>()
  const jobs = status.jobs.slice(0, 150).map((job) => {
    const key = JSON.stringify([job.sessionPath, job.sessionId])
    if (!labels.has(key)) labels.set(key, scopes.source(job)?.title || 'Unavailable lane')
    return { ...job, title: labels.get(key)! }
  })
  return { ...status, jobs }
}
