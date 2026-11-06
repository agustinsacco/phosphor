import { createHash, type Hash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  type LaneMoveMarks,
} from '@phosphor/shared/host-protocol-lane-transfer'
import {
  LANE_IMPORT_METHODS,
  parseLaneTransferParams,
  type LaneTransferParams,
} from '@phosphor/shared/host-protocol-lane-transfer-calls'
import { TransferRefusal, refuse } from '@phosphor/session-runtime/lane-transfer/files'
import { installLane } from '@phosphor/session-runtime/lane-transfer/install'
import {
  checkTarget,
  prepareImport,
  sessionTaken,
  type TargetInput,
} from '@phosphor/session-runtime/lane-transfer/move'
import type { WorktreePort } from '@phosphor/session-runtime/lane-transfer/target'
import type { HostStore } from '../../lanes/store'
import { LaneFolderError, prepareLaneFolder } from '../../lanes/worktree'
import type { FeatureContext, FeatureOutcome, HostFeature } from '../feature'
import { FeatureFailure, featureError } from '../machine'
import type { Staged, Staging } from './staging'

export interface LaneImportPorts {
  staging: Staging
  attachmentsRoot: string
  store: Pick<
    HostStore,
    'listRepositories' | 'ensureLane' | 'bindSessionFile' | 'setLaneMarks' | 'markRemoved'
  >
  /** Tell clients about the new lane. */
  published(laneId: string): void
}

interface Upload {
  received: number
  hash: Hash
  begin: Extract<LaneTransferParams, { method: 'laneTransfer.begin' }>
}

const ok = (data: unknown): FeatureOutcome => ({ ok: true, data })
const refused = (message: string) => ok({ blockers: [message] })

/** Lane folders the way `lane.create` makes them, so a moved lane looks like any other here. */
const worktrees: WorktreePort = {
  async add(root, branch, fresh) {
    const folder = await prepareLaneFolder({
      root,
      worktree: fresh ? { branch, fresh: true } : { branch },
    })
    return { cwd: folder.cwd, undo: folder.undo }
  },
}

/**
 * `laneTransfer.check`, `.begin`, `.chunk` and `.commit`: receive a bundle and
 * add it as a lane of a configured repository. Creating a lane needs
 * `sessions.control`. The Host picks every path; the bundle names none. A
 * commit checks everything again and undoes its own writes on any failure.
 */
export function createLaneImportFeature(
  context: FeatureContext,
  ports: LaneImportPorts,
): HostFeature {
  const uploads = new Map<string, Upload>()
  let tail: Promise<unknown> = Promise.resolve()
  const paths = { env: context.env, home: context.home }
  function target(repositoryId: string, branchPrefix: string, sameMachine: boolean): TargetInput {
    const repository = ports.store.listRepositories().find((r) => r.id === repositoryId)
    if (!repository) throw new FeatureFailure('bad-request')
    return {
      root: repository.path,
      workspace: repository.name,
      branchPrefix,
      sameMachine,
      maxTranscriptBytes: LIMIT.transcriptBytes,
    }
  }
  /** The bytes go once the commit ends either way; the job's answer stays for polling. */
  async function commit(staged: Staged, upload: Upload): Promise<{ laneId: string }> {
    try {
      return await admit(staged, upload)
    } finally {
      rmSync(staged.path, { force: true })
    }
  }
  async function admit(staged: Staged, upload: Upload): Promise<{ laneId: string }> {
    if (upload.received !== upload.begin.size || upload.hash.digest('hex') !== upload.begin.sha256)
      refuse('The lane bundle is damaged.')
    const { begin } = upload
    const input = target(begin.repositoryId, begin.branchPrefix, begin.sameMachine)
    const prepared = await prepareImport({ ...input, archivePath: staged.path, worktrees })
    let laneId: string | undefined
    let undo: (() => Promise<void>) | undefined
    try {
      const source = prepared.archive.manifest.source
      const id = ports.store.ensureLane({
        repositoryId: begin.repositoryId,
        cwd: prepared.folder.cwd,
        sessionFile: null,
        worktree: prepared.folder.worktree,
        title: source.title?.slice(0, 80) ?? null,
        branch: prepared.folder.branch,
      }).laneId
      laneId = id
      const installed = await installLane({
        archive: prepared.archive,
        plan: prepared.plan,
        cwd: prepared.folder.cwd,
        paths,
        labels: begin.notice,
        attachmentsDir: () => join(ports.attachmentsRoot, id),
        sessionTaken: sessionTaken(paths),
      })
      undo = installed.undo
      ports.store.bindSessionFile(id, installed.sessionFile)
      applyMarks(id, begin.marks)
      ports.published(id)
      context.log('lane.imported', { mode: prepared.plan.mode, bytes: begin.size })
      return { laneId: id }
    } catch (error) {
      if (laneId) ports.store.markRemoved(laneId)
      await undo?.()
      await prepared.folder.undo()
      throw error
    }
  }
  function applyMarks(laneId: string, marks: LaneMoveMarks) {
    if (marks.pinned || marks.marker !== null)
      ports.store.setLaneMarks(laneId, {
        ...(marks.pinned ? { pinned: true } : {}),
        ...(marks.marker !== null ? { marker: marks.marker } : {}),
      })
  }
  function chunk(p: Extract<LaneTransferParams, { method: 'laneTransfer.chunk' }>) {
    const upload = uploads.get(p.importId)
    const staged = ports.staging.get(p.importId)
    if (!upload || !staged || p.offset !== upload.received) throw new FeatureFailure('bad-request')
    const bytes = Buffer.from(p.data, 'base64')
    if (upload.received + bytes.length > upload.begin.size) throw new FeatureFailure('bad-request')
    const fd = openSync(staged.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
    try {
      if (fstatSync(fd).size !== upload.received) throw new FeatureFailure('bad-request')
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written)
    } finally {
      closeSync(fd)
    }
    upload.hash.update(bytes)
    upload.received += bytes.length
    return ok({})
  }
  async function run(method: string, params: unknown): Promise<FeatureOutcome> {
    const p = parseLaneTransferParams(method, params)
    if (!p) throw new FeatureFailure('bad-request')
    switch (p.method) {
      case 'laneTransfer.check':
        return ok(await checkTarget(target(p.repositoryId, p.branchPrefix, p.sameMachine), p.source))
      case 'laneTransfer.begin': {
        target(p.repositoryId, p.branchPrefix, p.sameMachine)
        for (const [id] of uploads) if (!ports.staging.get(id)) uploads.delete(id)
        const staged = ports.staging.create(2)
        if (!staged) throw new FeatureFailure('internal')
        closeSync(openSync(staged.entry.path, 'wx', 0o600))
        uploads.set(staged.id, { received: 0, hash: createHash('sha256'), begin: p })
        return ok({ importId: staged.id })
      }
      case 'laneTransfer.chunk':
        return chunk(p)
      case 'laneTransfer.commit': {
        const upload = uploads.get(p.importId)
        const staged = ports.staging.get(p.importId)
        if (!upload || !staged) throw new FeatureFailure('bad-request')
        uploads.delete(p.importId)
        // One commit at a time: two lanes racing for one branch or folder would each pass the checks.
        const job = tail.then(() => commit(staged, upload))
        tail = job.catch(() => undefined)
        ports.staging.track(staged, job, (error) => {
          if (error instanceof TransferRefusal || error instanceof LaneFolderError)
            return [error.message]
          context.log('feature.failed', { method, reason: 'internal' })
          return ['This Host could not add the lane. Nothing was kept.']
        })
        return ok({})
      }
      case 'laneTransfer.importStatus': {
        const staged = ports.staging.get(p.importId)
        if (!staged) throw new FeatureFailure('bad-request')
        return ok(staged.status)
      }
      default:
        throw new FeatureFailure('unsupported')
    }
  }
  return {
    capability: 'sessions.control',
    methods: LANE_IMPORT_METHODS,
    async call(method, params, authorized = () => false) {
      if (!authorized()) return featureError(new FeatureFailure('forbidden'))
      try {
        return await run(method, params)
      } catch (error) {
        if (error instanceof TransferRefusal || error instanceof LaneFolderError)
          return refused(error.message)
        context.log('feature.failed', {
          method,
          reason: error instanceof FeatureFailure ? error.code : 'internal',
        })
        return featureError(error)
      }
    },
  }
}

