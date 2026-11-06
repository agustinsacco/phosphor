import { closeSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { LANE_TRANSFER_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-lane-transfer'
import {
  LANE_EXPORT_METHODS,
  parseLaneTransferParams,
} from '@phosphor/shared/host-protocol-lane-transfer-calls'
import { TransferRefusal } from '@phosphor/session-runtime/lane-transfer/files'
import {
  exportLane,
  inspectLane,
  type SourceInput,
} from '@phosphor/session-runtime/lane-transfer/move'
import type { FeatureContext, FeatureOutcome, HostFeature } from '../feature'
import { FeatureFailure, featureError } from '../machine'
import type { Staging } from './staging'

export interface LaneExportPorts {
  staging: Staging
  /** Where this Host stores lane attachments: only those may leave with a lane. */
  attachmentsRoot: string
  /** The lane's live session, if one is running. */
  sessionFor(laneId: string): string | null
}

const STOP_FIRST = 'Stop this lane before moving it. Its saved transcript is what moves.'
const ok = (data: unknown): FeatureOutcome => ({ ok: true, data })

/**
 * `laneTransfer.inspect`, `.export`, `.read` and `.release`: read one stopped
 * lane into a bundle a client can carry to another machine. Reading it is
 * reading the lane, so `sessions.read` is enough; nothing here changes it.
 */
export function createLaneExportFeature(
  context: FeatureContext,
  ports: LaneExportPorts,
): HostFeature {
  function source(laneId: string): SourceInput | string {
    const lane = context.store.getLane(laneId)
    if (!lane || lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
    if (ports.sessionFor(laneId)) return STOP_FIRST
    if (!lane.sessionFile) return 'This lane has no saved transcript to move.'
    const repository = context.store.listRepositories().find((r) => r.id === lane.repositoryId)
    const own = join(ports.attachmentsRoot, laneId)
    return {
      sessionFile: lane.sessionFile,
      workspace: repository ? basename(repository.path) : 'workspace',
      paths: { env: context.env, home: context.home },
      attachmentAllowed: (path) => {
        try {
          return realpathSync(path).startsWith(`${realpathSync(own)}/`)
        } catch {
          return false
        }
      },
    }
  }
  async function run(method: string, params: unknown): Promise<FeatureOutcome> {
    const p = parseLaneTransferParams(method, params)
    if (!p) throw new FeatureFailure('bad-request')
    switch (p.method) {
      case 'laneTransfer.inspect': {
        const input = source(p.laneId)
        return ok(typeof input === 'string' ? { blockers: [input] } : await inspectLane(input))
      }
      case 'laneTransfer.export': {
        const input = source(p.laneId)
        if (typeof input === 'string') return ok({ blockers: [input] })
        const staged = ports.staging.create(4)
        if (!staged) throw new FeatureFailure('internal')
        const job = exportLane(input, staged.entry.path).then((value) => {
          context.log('lane.exported', { bytes: value.size })
          return value
        })
        ports.staging.track(staged.entry, job, (error) => {
          if (error instanceof TransferRefusal) return [error.message]
          context.log('feature.failed', { method, reason: 'internal' })
          return ['This Host could not read the lane.']
        })
        return ok({ exportId: staged.id })
      }
      case 'laneTransfer.exportStatus': {
        const staged = ports.staging.get(p.exportId)
        if (!staged) throw new FeatureFailure('bad-request')
        return ok(staged.status)
      }
      case 'laneTransfer.read': {
        const staged = ports.staging.get(p.exportId)
        if (!staged || !('state' in staged.status) || staged.status.state !== 'done')
          throw new FeatureFailure('bad-request')
        const fd = openSync(staged.path, 'r')
        try {
          const buffer = Buffer.alloc(LIMIT.chunkBytes)
          const count = readSync(fd, buffer, 0, buffer.length, p.offset)
          if (!count) throw new FeatureFailure('bad-request')
          return ok({ data: buffer.subarray(0, count).toString('base64') })
        } finally {
          closeSync(fd)
        }
      }
      case 'laneTransfer.release':
        ports.staging.release(p.exportId)
        return ok({})
      default:
        throw new FeatureFailure('unsupported')
    }
  }
  return {
    capability: 'sessions.read',
    methods: LANE_EXPORT_METHODS,
    async call(method, params, authorized = () => false) {
      if (!authorized()) return featureError(new FeatureFailure('forbidden'))
      try {
        return await run(method, params)
      } catch (error) {
        context.log('feature.failed', {
          method,
          reason: error instanceof FeatureFailure ? error.code : 'internal',
        })
        return featureError(error)
      }
    },
  }
}
