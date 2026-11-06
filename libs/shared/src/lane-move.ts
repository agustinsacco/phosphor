import { isUuid } from './control-api'
import {
  parseLaneMoveMarks,
  type LaneMoveMarks,
  type LaneMoveMode,
} from './host-protocol-lane-transfer'

/** `machine` is `local` for This Mac, otherwise a Host id, as for skill sharing. */
export type LaneMoveSource =
  { machine: 'local'; sessionPath: string } | { machine: string; laneId: string }

export type LaneMoveTarget =
  { machine: 'local'; workspace: string } | { machine: string; repositoryId: string }

export interface LaneMoveRequest {
  source: LaneMoveSource
  target: LaneMoveTarget
  /** The source row's pin and explicit marker, as the user sees them. */
  marks: LaneMoveMarks
}

/** What a move would do, or every reason it cannot. Nothing has changed yet. */
export interface LaneMovePlan {
  mode: LaneMoveMode
  branch: string | null
  workspace: string
  blockers: string[]
  bytes: number
}

export type LaneMoveResult =
  | { machine: 'local'; sessionPath: string; workspace: string }
  | { machine: string; laneId: string }
  | { blockers: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const machine = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
const path = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !v.includes('\0')

/** The renderer's request, checked in main before anything is read. */
export function parseLaneMoveRequest(v: unknown): LaneMoveRequest | null {
  if (!isRecord(v) || !isRecord(v.source) || !isRecord(v.target)) return null
  const marks = parseLaneMoveMarks(v.marks)
  const { source, target } = v
  if (!marks || !machine(source.machine) || !machine(target.machine)) return null
  const from: LaneMoveSource | null =
    source.machine === 'local'
      ? path(source.sessionPath)
        ? { machine: 'local', sessionPath: source.sessionPath }
        : null
      : isUuid(source.laneId)
        ? { machine: source.machine, laneId: source.laneId }
        : null
  const to: LaneMoveTarget | null =
    target.machine === 'local'
      ? path(target.workspace)
        ? { machine: 'local', workspace: target.workspace }
        : null
      : typeof target.repositoryId === 'string' && /^[0-9a-f]{16}$/.test(target.repositoryId)
        ? { machine: target.machine, repositoryId: target.repositoryId }
        : null
  return from && to ? { source: from, target: to, marks } : null
}
