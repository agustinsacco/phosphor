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
import type { RuntimeProbe } from '@phosphor/session-runtime/lane-transfer/runtime'
import type { Staging } from './staging'

export interface LaneExportPorts {
  runtime?: RuntimeProbe
  staging: Staging
  /** Where this Host stores lane attachments: only those may leave with a lane. */
  attachmentsRoot: string
  /** The lane's live session, if one is running. */
  sessionFor(laneId: string): string | null
}

const STOP_FIRST = 'Stop this lane before moving it. Its saved transcript is what moves.'
const ok = (data: unknown): FeatureOutcome => ({ ok: true, data })

/** What the shared exporter needs to read this lane, or the sentence saying why it cannot. */
function laneSource(
  context: FeatureContext,
  ports: LaneExportPorts,
  laneId: string,
): SourceInput | string {
  const lane = context.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
  if (ports.sessionFor(laneId)) return STOP_FIRST
  if (!lane.sessionFile) return 'This lane has no saved transcript to move.'
  const repository = context.store.listRepositories().find((r) => r.id === lane.repositoryId)
  const own = join(ports.attachmentsRoot, laneId)
  return {
    sessionFile: lane.sessionFile,
    runtime: ports.runtime,
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

function startExport(context: FeatureContext, staging: Staging, input: SourceInput) {
  const staged = staging.create(4)
  if (!staged) throw new FeatureFailure('internal')
  const job = exportLane(input, staged.entry.path).then((value) => {
    context.log('lane.exported', { bytes: value.size })
    return value
  })
  staging.track(staged.entry, job, (error) => {
    if (error instanceof TransferRefusal) return [error.message]
    context.log('feature.failed', { method: 'laneTransfer.export', reason: 'internal' })
    return ['This Host could not read the lane.']
  })
  return ok({ exportId: staged.id })
}

/** One chunk of a finished bundle, from `offset`. */
function readPart(staging: Staging, exportId: string, offset: number) {
  const staged = staging.get(exportId)
  if (!staged || !('state' in staged.status) || staged.status.state !== 'done')
    throw new FeatureFailure('bad-request')
  const fd = openSync(staged.path, 'r')
  try {
    const buffer = Buffer.alloc(LIMIT.chunkBytes)
    const count = readSync(fd, buffer, 0, buffer.length, offset)
    if (!count) throw new FeatureFailure('bad-request')
    return ok({ data: buffer.subarray(0, count).toString('base64') })
  } finally {
    closeSync(fd)
  }
}

/**
 * `laneTransfer.inspect`, `.export`, `.read` and `.release`: read one stopped
 * lane into a bundle a client can carry to another machine. Reading it is
 * more than its rendered messages (CLI ledgers and attached files included),
 * so it requires `sessions.control`, as HTML export does. Nothing here changes it.
 */
export function createLaneExportFeature(
  context: FeatureContext,
  ports: LaneExportPorts,
): HostFeature {
  async function run(method: string, params: unknown): Promise<FeatureOutcome> {
    const p = parseLaneTransferParams(method, params)
    if (!p) throw new FeatureFailure('bad-request')
    switch (p.method) {
      case 'laneTransfer.inspect': {
        const input = laneSource(context, ports, p.laneId)
        return ok(typeof input === 'string' ? { blockers: [input] } : await inspectLane(input))
      }
      case 'laneTransfer.export': {
        const input = laneSource(context, ports, p.laneId)
        if (typeof input === 'string') return ok({ blockers: [input] })
        return startExport(context, ports.staging, input)
      }
      case 'laneTransfer.exportStatus': {
        const staged = ports.staging.get(p.exportId)
        if (!staged) throw new FeatureFailure('bad-request')
        return ok(staged.status)
      }
      case 'laneTransfer.read':
        return readPart(ports.staging, p.exportId, p.offset)
      case 'laneTransfer.release':
        ports.staging.release(p.exportId)
        return ok({})
      default:
        throw new FeatureFailure('unsupported')
    }
  }
  return {
    capability: 'sessions.control',
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
