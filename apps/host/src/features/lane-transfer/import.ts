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
import type { RuntimeProbe } from '@phosphor/session-runtime/lane-transfer/runtime'
import type { Staged, Staging } from './staging'

export interface LaneImportPorts {
  runtime?: RuntimeProbe
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

type Params<M extends LaneTransferParams['method']> = Extract<LaneTransferParams, { method: M }>

interface ImportScope {
  context: FeatureContext
  ports: LaneImportPorts
  paths: { env: FeatureContext['env']; home: FeatureContext['home'] }
}

function repositoryTarget(
  ports: LaneImportPorts,
  p: { repositoryId: string; branchPrefix: string; sameMachine: boolean },
): TargetInput {
  const repository = ports.store.listRepositories().find((r) => r.id === p.repositoryId)
  if (!repository) throw new FeatureFailure('bad-request')
  return {
    root: repository.path,
    runtime: ports.runtime,
    workspace: repository.name,
    branchPrefix: p.branchPrefix,
    sameMachine: p.sameMachine,
    maxTranscriptBytes: LIMIT.transcriptBytes,
    maxTitleLength: 80,
  }
}

function applyMarks(store: LaneImportPorts['store'], laneId: string, marks: LaneMoveMarks) {
  if (marks.pinned || marks.marker !== null)
    store.setLaneMarks(laneId, {
      ...(marks.pinned ? { pinned: true } : {}),
      ...(marks.marker !== null ? { marker: marks.marker } : {}),
    })
}

/** Check the received bytes, then add the lane; any failure undoes every write it made. */
async function admit(
  scope: ImportScope,
  staged: Staged,
  upload: Upload,
): Promise<{ laneId: string }> {
  const { ports, paths } = scope
  if (upload.received !== upload.begin.size || upload.hash.digest('hex') !== upload.begin.sha256)
    refuse('The lane bundle is damaged.')
  const { begin } = upload
  const input = repositoryTarget(ports, begin)
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
      title: source.title,
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
    applyMarks(ports.store, id, begin.marks)
    ports.published(id)
    scope.context.log('lane.imported', { mode: prepared.plan.mode, bytes: begin.size })
    return { laneId: id }
  } catch (error) {
    if (laneId) ports.store.markRemoved(laneId)
    await undo?.()
    await prepared.folder.undo()
    throw error
  }
}

function writeChunk(
  upload: Upload | undefined,
  staged: Staged | undefined,
  p: Params<'laneTransfer.chunk'>,
) {
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

/** The import calls over one map of uploads in flight and one commit queue. */
function importCalls(scope: ImportScope) {
  const { ports, context } = scope
  const uploads = new Map<string, Upload>()
  let tail: Promise<unknown> = Promise.resolve()
  /** The bytes go once the commit ends either way; the job's answer stays for polling. */
  const commit = (staged: Staged, upload: Upload) =>
    admit(scope, staged, upload).finally(() => rmSync(staged.path, { force: true }))
  return {
    begin(p: Params<'laneTransfer.begin'>) {
      repositoryTarget(ports, p)
      for (const [id] of uploads) if (!ports.staging.get(id)) uploads.delete(id)
      const staged = ports.staging.create(2)
      if (!staged) throw new FeatureFailure('internal')
      closeSync(openSync(staged.entry.path, 'wx', 0o600))
      uploads.set(staged.id, { received: 0, hash: createHash('sha256'), begin: p })
      return ok({ importId: staged.id })
    },
    chunk: (p: Params<'laneTransfer.chunk'>) =>
      writeChunk(uploads.get(p.importId), ports.staging.get(p.importId), p),
    commit(p: { importId: string; method: string }) {
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
        context.log('feature.failed', { method: p.method, reason: 'internal' })
        return ['This Host could not add the lane. Nothing was kept.']
      })
      return ok({})
    },
  }
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
  const scope: ImportScope = { context, ports, paths: { env: context.env, home: context.home } }
  const calls = importCalls(scope)
  async function run(method: string, params: unknown): Promise<FeatureOutcome> {
    const p = parseLaneTransferParams(method, params)
    if (!p) throw new FeatureFailure('bad-request')
    switch (p.method) {
      case 'laneTransfer.check':
        return ok(await checkTarget(repositoryTarget(ports, p), p.source))
      case 'laneTransfer.begin':
        return calls.begin(p)
      case 'laneTransfer.chunk':
        return calls.chunk(p)
      case 'laneTransfer.commit':
        return calls.commit(p)
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
