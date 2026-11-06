/**
 * `laneTransfer.*` call parameters and results. Export calls read one lane
 * (`sessions.read`); import calls create one (`sessions.control`). The Host
 * chooses every path it writes; no parameter names a file on the Host.
 */
import { isUuid } from './control-api'
import { attachmentBase64 } from './host-protocol-attachments'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  isBranchPrefix,
  isTransferId,
  parseLaneMoveMarks,
  parseLaneMoveNotice,
  parseLaneSourceFacts,
  type LaneMoveMarks,
  type LaneMoveNotice,
  type LaneSourceFacts,
} from './host-protocol-lane-transfer'

export const LANE_EXPORT_METHODS = [
  'laneTransfer.inspect',
  'laneTransfer.export',
  'laneTransfer.read',
  'laneTransfer.release',
] as const
export const LANE_IMPORT_METHODS = [
  'laneTransfer.check',
  'laneTransfer.begin',
  'laneTransfer.chunk',
  'laneTransfer.commit',
] as const

export type LaneTransferParams =
  | { method: 'laneTransfer.inspect' | 'laneTransfer.export'; laneId: string }
  | { method: 'laneTransfer.read'; exportId: string; offset: number }
  | { method: 'laneTransfer.release'; exportId: string }
  | {
      method: 'laneTransfer.check'
      repositoryId: string
      source: LaneSourceFacts
      branchPrefix: string
    }
  | {
      method: 'laneTransfer.begin'
      repositoryId: string
      size: number
      sha256: string
      branchPrefix: string
      notice: LaneMoveNotice
      marks: LaneMoveMarks
    }
  | { method: 'laneTransfer.chunk'; importId: string; offset: number; data: string }
  | { method: 'laneTransfer.commit'; importId: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k))
const offset = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= LIMIT.bundleBytes
const repositoryId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)

/** Canonical base64 of at most one chunk. */
export function isChunkData(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && attachmentBase64(v, LIMIT.chunkBytes)
}

export function parseLaneTransferParams(method: string, v: unknown): LaneTransferParams | null {
  if (!isRecord(v)) return null
  switch (method) {
    case 'laneTransfer.inspect':
    case 'laneTransfer.export':
      return keys(v, ['laneId']) && isUuid(v.laneId) ? { method, laneId: v.laneId } : null
    case 'laneTransfer.read':
      return keys(v, ['exportId', 'offset']) && isTransferId(v.exportId) && offset(v.offset)
        ? { method, exportId: v.exportId, offset: v.offset }
        : null
    case 'laneTransfer.release':
      return keys(v, ['exportId']) && isTransferId(v.exportId)
        ? { method, exportId: v.exportId }
        : null
    case 'laneTransfer.check': {
      const source = parseLaneSourceFacts(v.source)
      return keys(v, ['repositoryId', 'source', 'branchPrefix']) &&
        repositoryId(v.repositoryId) &&
        source &&
        isBranchPrefix(v.branchPrefix)
        ? { method, repositoryId: v.repositoryId, source, branchPrefix: v.branchPrefix }
        : null
    }
    case 'laneTransfer.begin': {
      const notice = parseLaneMoveNotice(v.notice)
      const marks = parseLaneMoveMarks(v.marks)
      return keys(v, ['repositoryId', 'size', 'sha256', 'branchPrefix', 'notice', 'marks']) &&
        repositoryId(v.repositoryId) &&
        offset(v.size) &&
        typeof v.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(v.sha256) &&
        isBranchPrefix(v.branchPrefix) &&
        notice &&
        marks
        ? {
            method,
            repositoryId: v.repositoryId,
            size: v.size,
            sha256: v.sha256,
            branchPrefix: v.branchPrefix,
            notice,
            marks,
          }
        : null
    }
    case 'laneTransfer.chunk':
      return keys(v, ['importId', 'offset', 'data']) &&
        isTransferId(v.importId) &&
        offset(v.offset) &&
        isChunkData(v.data)
        ? { method, importId: v.importId, offset: v.offset, data: v.data }
        : null
    case 'laneTransfer.commit':
      return keys(v, ['importId']) && isTransferId(v.importId)
        ? { method, importId: v.importId }
        : null
    default:
      return null
  }
}

export interface LaneExportStarted {
  exportId: string
  size: number
  sha256: string
}

export function parseLaneExportStarted(v: unknown): LaneExportStarted | null {
  return isRecord(v) &&
    keys(v, ['exportId', 'size', 'sha256']) &&
    isTransferId(v.exportId) &&
    offset(v.size) &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256)
    ? { exportId: v.exportId, size: v.size, sha256: v.sha256 }
    : null
}

export function parseLaneChunk(v: unknown): string | null {
  return isRecord(v) && keys(v, ['data']) && isChunkData(v.data) ? v.data : null
}

/** An inspection: the facts when the lane can leave, otherwise why it cannot. */
export type LaneInspection = { facts: LaneSourceFacts } | { blockers: string[] }

export function parseLaneInspection(v: unknown): LaneInspection | null {
  if (!isRecord(v)) return null
  if (keys(v, ['facts'])) {
    const facts = parseLaneSourceFacts(v.facts)
    return facts ? { facts } : null
  }
  return keys(v, ['blockers']) &&
    Array.isArray(v.blockers) &&
    v.blockers.length > 0 &&
    v.blockers.length <= LIMIT.messages &&
    v.blockers.every((b) => typeof b === 'string' && b.length > 0 && b.length <= 300)
    ? { blockers: v.blockers as string[] }
    : null
}
