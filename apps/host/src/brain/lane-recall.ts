import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BrainOpsPort } from '@phosphor/session-runtime/ops/types'
import type { SpawnInputs } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { GuardedBrainService, HostBrain } from './runtime'

/** What ordinary lanes get from the Host's own Brain: recall resources and a per-lane op port. */
export interface HostLaneRecall {
  /** The Host's Brain answers lanes now; a Desktop registration is not consulted. */
  active(): boolean
  /** Recall's extension and skill when Brain and recall are on; never throws. */
  resources(workspacePath: string): Promise<Pick<SpawnInputs, 'extensions' | 'skills'> | undefined>
  /** Binds a live lane's handle to its folder and saved pi session id; returns its release. */
  attachLane(handle: string, cwd: string, piSessionId: () => string | undefined): () => void
  /** The lane's port, holding its latest briefing refs, until the lane ends. */
  forLane(handle: string, title: string): Promise<BrainOpsPort | undefined>
}

type Lane = { cwd: string; piSessionId: () => string | undefined }
type Bound = { service: GuardedBrainService; sessionId: string; port: BrainOpsPort }

const real = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export function createHostLaneRecall(
  brain: Pick<HostBrain, 'active' | 'service' | 'laneFolder'>,
  log: (message: string, data?: Record<string, unknown>) => void,
): HostLaneRecall {
  const lanes = new Map<string, Lane>()
  const ports = new WeakMap<Lane, Bound>()
  return {
    active: () => brain.active(),
    async resources(workspacePath) {
      // The Brain lane gets Brain Agent's tools from its owner, never recall.
      if (real(workspacePath) === real(brain.laneFolder)) return undefined
      try {
        return (await (await brain.service())?.recallLaunch()) ?? undefined
      } catch (error) {
        log('Brain recall unavailable', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return undefined
      }
    },
    attachLane(handle, cwd, piSessionId) {
      const lane = { cwd, piSessionId }
      lanes.set(handle, lane)
      return () => {
        if (lanes.get(handle) === lane) lanes.delete(handle)
      }
    },
    async forLane(handle, title) {
      const lane = lanes.get(handle)
      // The saved pi session id is the lane's identity in Brain; before pi reports it, no port.
      const sessionId = lane?.piSessionId()
      if (!lane || !sessionId) return undefined
      const service = await brain.service()
      if (!service) return undefined
      let bound = ports.get(lane)
      if (bound?.service !== service || bound.sessionId !== sessionId) {
        bound = { service, sessionId, port: service.forLane({ sessionId, cwd: lane.cwd, title }) }
        ports.set(lane, bound)
      }
      return bound.port
    },
  }
}
