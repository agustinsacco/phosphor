import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LaneMoveNotice } from '@shared/host-protocol-lane-transfer'
import type { LaneInspection } from '@shared/host-protocol-lane-transfer-calls'
import type { LaneMovePlan, LaneMoveRequest, LaneMoveResult } from '@shared/lane-move'
import {
  LANE_BUNDLE_DAMAGED,
  LANE_MOVE_BUSY,
  moveBranchPrefix,
  moveLabel,
  refusedPlan,
} from '@phosphor/host-client/lane-move'
import { sha256Of } from '@phosphor/session-runtime/lane-transfer/archive'
import { TransferRefusal } from '@phosphor/session-runtime/lane-transfer/files'
import { localLanes } from './local'
import { remoteLaneTransfer } from './remote'

export interface LaneMovePorts {
  connection: Parameters<typeof remoteLaneTransfer>[0]
  label(hostId: string): string
  branchPrefix(): string
  tempDir(): string
}

const LOCAL = 'This Mac'

/** What every step of one move needs: the branch prefix, the labels and the two ends. */
function moveContext(ports: LaneMovePorts, request: LaneMoveRequest) {
  const name = (machine: string) => (machine === 'local' ? LOCAL : moveLabel(ports.label(machine)))
  const notice: LaneMoveNotice = {
    from: name(request.source.machine),
    to: name(request.target.machine),
  }
  return {
    request,
    prefix: moveBranchPrefix(ports.branchPrefix()),
    notice,
    same: request.source.machine === request.target.machine,
    remote: (hostId: string) => remoteLaneTransfer(ports.connection, hostId),
  }
}
type MoveContext = ReturnType<typeof moveContext>

async function inspect({ request, same, remote }: MoveContext): Promise<LaneInspection> {
  const { source } = request
  if ('sessionPath' in source) return localLanes.inspect(source.sessionPath, !same)
  return remote(source.machine).inspect(source.laneId)
}

async function planMove(ctx: MoveContext): Promise<LaneMovePlan> {
  try {
    const inspection = await inspect(ctx)
    if ('blockers' in inspection) return refusedPlan(inspection.blockers)
    const { facts } = inspection
    const { target } = ctx.request
    const checked =
      'workspace' in target
        ? await localLanes.check(target.workspace, facts, ctx.prefix, ctx.same)
        : await ctx.remote(target.machine).check(target.repositoryId, facts, ctx.prefix, ctx.same)
    return { ...checked, bytes: facts.bytes }
  } catch (error) {
    if (error instanceof TransferRefusal) return refusedPlan([error.message])
    throw error
  }
}

async function transfer(ctx: MoveContext, archive: string): Promise<LaneMoveResult> {
  const { source, target } = ctx.request
  const exported =
    'sessionPath' in source
      ? await localLanes.export(source.sessionPath, !ctx.same, archive)
      : await ctx.remote(source.machine).download(source.laneId, archive)
  if ('blockers' in exported) return exported
  if ((await sha256Of(archive)) !== exported.sha256) return { blockers: [LANE_BUNDLE_DAMAGED] }
  if ('workspace' in target) {
    const local = await localLanes.import({
      archive,
      workspace: target.workspace,
      branchPrefix: ctx.prefix,
      sameMachine: ctx.same,
      labels: ctx.notice,
    })
    return { machine: 'local', ...local }
  }
  const added = await ctx.remote(target.machine).upload({
    path: archive,
    size: exported.size,
    sha256: exported.sha256,
    repositoryId: target.repositoryId,
    branchPrefix: ctx.prefix,
    sameMachine: ctx.same,
    notice: ctx.notice,
    marks: ctx.request.marks,
  })
  return 'laneId' in added ? { machine: target.machine, laneId: added.laneId } : added
}

/**
 * Copy a lane from one machine to another, or into another workspace on the
 * same machine. Every byte passes through one private temp file on This Mac,
 * also between two Hosts, so Desktop never holds a whole bundle in memory and
 * two Hosts never talk to each other. The browser, which has no disk of its
 * own, relays between Hosts in memory instead (`@phosphor/host-client/lane-move`).
 * The source is only read; a refusal anywhere changes nothing. One move runs
 * at a time.
 */
export function createLaneMoves(ports: LaneMovePorts) {
  let running = false
  async function move(request: LaneMoveRequest): Promise<LaneMoveResult> {
    if (running) return { blockers: [LANE_MOVE_BUSY] }
    running = true
    let dir: string | undefined
    try {
      const ctx = moveContext(ports, request)
      const checked = await planMove(ctx)
      if (checked.blockers.length) return { blockers: checked.blockers }
      dir = await mkdtemp(join(ports.tempDir(), 'phosphor-lane-'))
      return await transfer(ctx, join(dir, 'lane.bundle'))
    } catch (error) {
      if (error instanceof TransferRefusal) return { blockers: [error.message] }
      throw error
    } finally {
      running = false
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
  return { plan: (request: LaneMoveRequest) => planMove(moveContext(ports, request)), move }
}
