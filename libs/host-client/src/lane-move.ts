import { normalizePrefix } from '@phosphor/shared/branchName'
import { isBranchPrefix, type LaneMoveNotice } from '@phosphor/shared/host-protocol-lane-transfer'
import type { LaneMovePlan, LaneMoveRequest, LaneMoveResult } from '@phosphor/shared/lane-move'
import { sha256Hex } from './crypto'
import {
  remoteLaneTransfer,
  type LaneBundleWriter,
  type LaneTransferConnection,
} from './lane-transfer'

export const LANE_MOVE_BUSY = 'Another lane is moving. Wait for it to finish.'
export const LANE_BUNDLE_DAMAGED = 'The lane bundle is damaged.'

// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
/** A machine's name as a move notice records it: one line, at most 80 characters. */
export const moveLabel = (text: string): string =>
  text.replace(controls, ' ').trim().slice(0, 80) || 'a Host'

/** The configured branch prefix as a move sends it, or none when it is not branch-safe. */
export function moveBranchPrefix(configured: string): string {
  const value = normalizePrefix(configured)
  return isBranchPrefix(value) ? value : ''
}

export const refusedPlan = (blockers: string[]): LaneMovePlan => ({
  mode: 'folder',
  branch: null,
  workspace: '',
  blockers,
  bytes: 0,
})

/** A move whose two ends are Hosts: between two of them, or between folders of one. */
export type HostLaneMoveRequest = LaneMoveRequest & {
  source: { machine: string; laneId: string }
  target: { machine: string; repositoryId: string }
}
export const isHostLaneMove = (request: LaneMoveRequest): request is HostLaneMoveRequest =>
  'laneId' in request.source && 'repositoryId' in request.target

export interface HostLaneMovePorts {
  connection: LaneTransferConnection
  label(hostId: string): string
  branchPrefix(): string | Promise<string>
}

async function moveContext(
  ports: HostLaneMovePorts,
  request: HostLaneMoveRequest,
  signal?: AbortSignal,
) {
  const { source, target } = request
  const notice: LaneMoveNotice = {
    from: moveLabel(ports.label(source.machine)),
    to: moveLabel(ports.label(target.machine)),
  }
  return {
    request,
    prefix: moveBranchPrefix(await ports.branchPrefix()),
    notice,
    same: source.machine === target.machine,
    source: remoteLaneTransfer(ports.connection, source.machine, signal),
    target: remoteLaneTransfer(ports.connection, target.machine, signal),
  }
}
type MoveContext = Awaited<ReturnType<typeof moveContext>>

async function checkMove(ctx: MoveContext): Promise<LaneMovePlan> {
  const inspection = await ctx.source.inspect(ctx.request.source.laneId)
  if ('blockers' in inspection) return refusedPlan(inspection.blockers)
  const { facts } = inspection
  const checked = await ctx.target.check(
    ctx.request.target.repositoryId,
    facts,
    ctx.prefix,
    ctx.same,
  )
  return { ...checked, bytes: facts.bytes }
}

/** What moving a Host lane would do: the source Host's facts, checked by the target Host. */
export async function planHostLaneMove(
  ports: HostLaneMovePorts,
  request: HostLaneMoveRequest,
): Promise<LaneMovePlan> {
  return checkMove(await moveContext(ports, request))
}

/** One buffer the size the Host announced, filled in order. */
function memoryBundle() {
  let bytes = new Uint8Array(0)
  let filled = 0
  return {
    open: async (size: number): Promise<LaneBundleWriter> => {
      bytes = new Uint8Array(size)
      return {
        write: async (chunk) => {
          bytes.set(chunk, filled)
          filled += chunk.length
        },
        close: async () => undefined,
      }
    },
    bytes: () => bytes.subarray(0, filled),
  }
}

/**
 * Copy a Host lane to another Host, or into another folder of the same Host,
 * through this device's memory: the bundle is downloaded whole, its SHA-256
 * checked, then sent. Nothing is written to this device's disk, and the two
 * Hosts never talk to each other. The source is only read; a refusal anywhere
 * changes nothing, and an aborted `signal` stops the move before its commit.
 */
export async function moveHostLane(
  ports: HostLaneMovePorts,
  request: HostLaneMoveRequest,
  signal?: AbortSignal,
): Promise<LaneMoveResult> {
  const ctx = await moveContext(ports, request, signal)
  const checked = await checkMove(ctx)
  if (checked.blockers.length) return { blockers: checked.blockers }
  const bundle = memoryBundle()
  const exported = await ctx.source.download(request.source.laneId, bundle.open)
  if ('blockers' in exported) return exported
  const bytes = bundle.bytes()
  if (bytes.length !== exported.size || (await sha256Hex(bytes)) !== exported.sha256)
    return { blockers: [LANE_BUNDLE_DAMAGED] }
  const added = await ctx.target.upload(
    {
      size: exported.size,
      sha256: exported.sha256,
      repositoryId: request.target.repositoryId,
      branchPrefix: ctx.prefix,
      sameMachine: ctx.same,
      notice: ctx.notice,
      marks: request.marks,
    },
    async (offset, length) => bytes.subarray(offset, offset + length),
  )
  return 'laneId' in added ? { machine: request.target.machine, laneId: added.laneId } : added
}

/**
 * Moves between Hosts for a client that has no machine of its own (the
 * browser): one at a time, and `abort` stops the one running, which then drops
 * its bytes. Requests with This Mac on either end are the caller's to refuse.
 */
export function createHostLaneMoves(ports: HostLaneMovePorts) {
  let running: AbortController | null = null
  return {
    plan: (request: HostLaneMoveRequest) => planHostLaneMove(ports, request),
    async move(request: HostLaneMoveRequest): Promise<LaneMoveResult> {
      if (running) return { blockers: [LANE_MOVE_BUSY] }
      const controller = new AbortController()
      running = controller
      try {
        return await moveHostLane(ports, request, controller.signal)
      } finally {
        running = null
      }
    },
    abort: () => running?.abort(),
  }
}
