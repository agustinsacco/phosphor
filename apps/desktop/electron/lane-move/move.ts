import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePrefix } from '@shared/branchName'
import { isBranchPrefix, type LaneMoveNotice } from '@shared/host-protocol-lane-transfer'
import type { LaneInspection } from '@shared/host-protocol-lane-transfer-calls'
import type { LaneMovePlan, LaneMoveRequest, LaneMoveResult } from '@shared/lane-move'
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
// eslint-disable-next-line no-control-regex
const label = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 80) || 'a Host'

/**
 * Copy a lane from one machine to another, or into another workspace on the
 * same machine. Every byte passes through one temp file on This Mac, so the
 * same path serves This Mac and Host on either end, and two Hosts never talk
 * to each other. The source is only read; a refusal anywhere changes nothing.
 */
export function createLaneMoves(ports: LaneMovePorts) {
  let running = false
  const prefix = () => {
    const value = normalizePrefix(ports.branchPrefix())
    return isBranchPrefix(value) ? value : ''
  }
  const remote = (hostId: string) => remoteLaneTransfer(ports.connection, hostId)
  const labels = (request: LaneMoveRequest): LaneMoveNotice => ({
    from: request.source.machine === 'local' ? LOCAL : label(ports.label(request.source.machine)),
    to: request.target.machine === 'local' ? LOCAL : label(ports.label(request.target.machine)),
  })
  const same = (request: LaneMoveRequest) => request.source.machine === request.target.machine

  async function inspect(request: LaneMoveRequest): Promise<LaneInspection> {
    const { source } = request
    if ('sessionPath' in source) return localLanes.inspect(source.sessionPath, !same(request))
    return remote(source.machine).inspect(source.laneId)
  }

  async function plan(request: LaneMoveRequest): Promise<LaneMovePlan> {
    try {
      const inspection = await inspect(request)
      if ('blockers' in inspection)
        return { mode: 'folder', branch: null, workspace: '', blockers: inspection.blockers, bytes: 0 }
      const { facts } = inspection
      const { target } = request
      const checked =
        'workspace' in target
          ? await localLanes.check(target.workspace, facts, prefix(), same(request))
          : await remote(target.machine).check(target.repositoryId, facts, prefix(), same(request))
      return { ...checked, bytes: facts.bytes }
    } catch (error) {
      if (error instanceof TransferRefusal)
        return { mode: 'folder', branch: null, workspace: '', blockers: [error.message], bytes: 0 }
      throw error
    }
  }

  async function transfer(request: LaneMoveRequest, archive: string): Promise<LaneMoveResult> {
    const { source, target } = request
    const exported =
      'sessionPath' in source
        ? await localLanes.export(source.sessionPath, !same(request), archive)
        : await remote(source.machine).download(source.laneId, archive)
    if ('blockers' in exported) return exported
    if ((await sha256Of(archive)) !== exported.sha256) return { blockers: ['The lane bundle is damaged.'] }
    if ('workspace' in target) {
      const local = await localLanes.import({
        archive,
        workspace: target.workspace,
        branchPrefix: prefix(),
        sameMachine: same(request),
        labels: labels(request),
      })
      return { machine: 'local', ...local }
    }
    const added = await remote(target.machine).upload({
      path: archive,
      size: exported.size,
      sha256: exported.sha256,
      repositoryId: target.repositoryId,
      branchPrefix: prefix(),
      sameMachine: same(request),
      notice: labels(request),
      marks: request.marks,
    })
    return 'laneId' in added ? { machine: target.machine, laneId: added.laneId } : added
  }

  async function move(request: LaneMoveRequest): Promise<LaneMoveResult> {
    if (running) return { blockers: ['Another lane is moving. Wait for it to finish.'] }
    running = true
    let dir: string | undefined
    try {
      const checked = await plan(request)
      if (checked.blockers.length) return { blockers: checked.blockers }
      dir = await mkdtemp(join(ports.tempDir(), 'phosphor-lane-'))
      return await transfer(request, join(dir, 'lane.bundle'))
    } catch (error) {
      if (error instanceof TransferRefusal) return { blockers: [error.message] }
      throw error
    } finally {
      running = false
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }

  return { plan, move }
}
