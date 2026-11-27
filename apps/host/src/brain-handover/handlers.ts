/**
 * `owner.brainHandover.*` on the owner socket: This Mac's Desktop Brain moving once into the
 * Host's empty `<state>/brain` (docs/brain-handover.md). Owner-only: a `local` principal and
 * every grant connection never reach these. Calls run one at a time; every mutation is
 * idempotent by its migration id, and a lost answer is recovered with `status`.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrainHandoverState,
  BrainReaderReadiness,
  OwnerCalls,
} from '@phosphor/shared/host-protocol-owner'
import { OwnerCallRefused } from '../owner/adapter'
import {
  handoverPaths,
  privateFolder,
  readClaim,
  targetOccupied,
  writeRecord,
  type HandoverRecord,
} from './layout'
import {
  abandon,
  completePublished,
  PublishRefused,
  publishSealed,
  reconcile,
  releaseOrphanClaim,
} from './publish'
import { SealRefused, sealStaged, type PinnedEmbeddingModel } from './seal'
import { verifySealed, VerifyRefused } from './verify'

/** Binds the moved Brain Agent conversation to the Host's reserved Brain lane. */
export type BrainAgentTranscriptImporter = (input: {
  readonly migrationId: string
  /** `<state>/brain/Brain`, published. */
  readonly laneFolder: string
  /** Sealed, Host-owned, read-only copies verified against the owner's hashes. */
  readonly transcripts: readonly {
    readonly name: string
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly sessionId: string
  }[]
  /** The transcript (one of `transcripts`, by name) the lane resumes; null when none. */
  readonly active: string | null
}) => Promise<{ bound: string | null }>

export interface BrainHandoverPorts {
  readonly stateDir: string
  readonly uid: number | undefined
  readonly now?: () => number
  /** Whether the Host's lane inventory still has a lane on this transcript. */
  readonly laneForSessionFile: (path: string) => boolean
  /**
   * Preflight, at `begin` and again before publishing: a qualified packaged reader on this
   * target and a runnable pi, resolved locally without credentials or a model.
   */
  readonly readerReadiness: () => Promise<BrainReaderReadiness>
  /** Without one the Host does not offer a move: the conversation would have nowhere to go. */
  readonly importAgentTranscripts?: BrainAgentTranscriptImporter
  /** The pinned model the Host accepts. Without one the Host does not offer a move. */
  readonly embeddingModel?: PinnedEmbeddingModel
  /**
   * Final readiness, before Desktop gives up its Brain: the packaged embedding worker loads the
   * sealed, hash-verified model and embeds invented text. Never downloads. Without one the Host
   * does not offer a move.
   */
  readonly probeModel?: (embeddingsDirectory: string) => Promise<boolean>
  readonly log?: (event: string, fields?: Record<string, unknown>) => void
}

type HandoverMethod =
  | 'owner.brainHandover.status'
  | 'owner.brainHandover.begin'
  | 'owner.brainHandover.verify'
  | 'owner.brainHandover.commit'
  | 'owner.brainHandover.abort'
/** Owner handlers that need no call context: the socket admits only the attested owner. */
type Handlers = {
  readonly [M in HandoverMethod]: (
    params: OwnerCalls[M]['params'],
  ) => Promise<OwnerCalls[M]['result']>
}

const refused = (message: string) => new OwnerCallRefused('forbidden', message)
const NOT_SUPPORTED = 'This Phosphor service cannot take a Brain yet.'
const READER = 'This Phosphor service cannot run the Brain reader yet.'

/** Every production port a move needs; a Host missing one never offers it. */
const supported = (ports: BrainHandoverPorts): boolean =>
  !!ports.importAgentTranscripts && !!ports.probeModel && !!ports.embeddingModel

/** Refusals a caller can read; anything else answers `internal`. */
function asRefusal(error: unknown): unknown {
  if (error instanceof SealRefused || error instanceof VerifyRefused)
    return new OwnerCallRefused('bad-request', error.message)
  if (error instanceof PublishRefused) return refused(error.message)
  return error
}

function stateOf(record: HandoverRecord | null): BrainHandoverState {
  return record?.state ?? 'none'
}

function liveClaim(ports: BrainHandoverPorts, persist = true): HandoverRecord | null {
  const claim = readClaim(ports.stateDir)
  if (!claim) return null
  const record = reconcile(ports.stateDir, claim.migrationId, persist)
  return record && (record.state === 'staged' || record.state === 'verified') ? record : null
}

async function begin(
  ports: BrainHandoverPorts,
  params: OwnerCalls['owner.brainHandover.begin']['params'],
): Promise<OwnerCalls['owner.brainHandover.begin']['result']> {
  const paths = handoverPaths(ports.stateDir, params.migrationId)
  const existing = reconcile(ports.stateDir, params.migrationId)
  if (existing?.state === 'staged') return { state: 'staged', staging: paths.stage }
  if (existing) throw refused(`This move is already ${existing.state}.`)
  if (!supported(ports)) throw refused(NOT_SUPPORTED)
  if ((await ports.readerReadiness()) !== 'qualified') throw refused(READER)
  const other = liveClaim(ports)
  if (other) throw refused('Another Brain move is in progress.')
  if (targetOccupied(ports.stateDir)) throw refused('This Phosphor service already has a Brain.')
  privateFolder(paths.root)
  writeRecord(paths.claim, { migrationId: params.migrationId })
  privateFolder(paths.move)
  privateFolder(paths.stage)
  const record: HandoverRecord = {
    version: 1,
    migrationId: params.migrationId,
    state: 'staged',
    sourceSchema: params.sourceSchema,
    sourceGeneration: params.sourceGeneration,
    desktopVersion: params.desktopVersion,
  }
  writeRecord(paths.record, record)
  ports.log?.('brain.handover.begin', { migrationId: params.migrationId })
  return { state: 'staged', staging: paths.stage }
}

async function verify(
  ports: BrainHandoverPorts,
  params: OwnerCalls['owner.brainHandover.verify']['params'],
): Promise<OwnerCalls['owner.brainHandover.verify']['result']> {
  const record = reconcile(ports.stateDir, params.migrationId)
  if (record?.state === 'verified' && record.report)
    return { state: 'verified', report: record.report }
  if (record?.state !== 'staged') throw refused(`This move is ${stateOf(record)}.`)
  const paths = handoverPaths(ports.stateDir, params.migrationId)
  // A failed attempt left partial copies; a retry seals again from the stage.
  await rm(paths.sealed, { recursive: true, force: true })
  privateFolder(paths.sealed)
  try {
    const seal = await sealStaged({
      stage: paths.stage,
      sealed: paths.sealed,
      files: params.files,
      uid: ports.uid,
      model: ports.embeddingModel,
    })
    const probe = ports.probeModel
    if (!probe || !supported(ports)) throw refused(NOT_SUPPORTED)
    const checked = await verifySealed({
      sealedDir: paths.sealed,
      scratch: paths.scratch,
      record,
      seal,
      laneForSessionFile: ports.laneForSessionFile,
      now: (ports.now ?? Date.now)(),
      activeTranscript: params.activeTranscript,
    })
    if (seal.model !== 'moved')
      throw new VerifyRefused('The Brain’s embedding model did not arrive from this Mac.')
    if (!(await probe(join(paths.sealed, 'brain', 'embeddings'))))
      throw new VerifyRefused('The moved embedding model did not run on this Phosphor service.')
    writeRecord(paths.record, { ...record, state: 'verified', ...checked })
    ports.log?.('brain.handover.verified', { migrationId: params.migrationId })
    return { state: 'verified', report: checked.report }
  } catch (error) {
    await rm(paths.sealed, { recursive: true, force: true })
    throw asRefusal(error)
  }
}

async function commit(
  ports: BrainHandoverPorts,
  params: OwnerCalls['owner.brainHandover.commit']['params'],
): Promise<OwnerCalls['owner.brainHandover.commit']['result']> {
  let record = reconcile(ports.stateDir, params.migrationId)
  if (record?.state === 'committed') return { state: 'committed' }
  if (!record || (record.state !== 'verified' && record.state !== 'published'))
    throw refused(`This move is ${stateOf(record)}.`)
  const importer = ports.importAgentTranscripts
  if (!importer) throw refused(NOT_SUPPORTED)
  if (record.state === 'verified') {
    // The reader can go between verify and commit (an update, a removed bundle): check again.
    if ((await ports.readerReadiness().catch(() => 'unavailable')) !== 'qualified')
      throw refused(READER)
    try {
      record = await publishSealed(ports.stateDir, record)
    } catch (error) {
      throw asRefusal(error)
    }
  }
  // Published: the Host owns the Brain. A failed binding is retried by the next commit.
  await completePublished(ports.stateDir, record, importer)
  ports.log?.('brain.handover.committed', { migrationId: params.migrationId })
  return { state: 'committed' }
}

async function abort(
  ports: BrainHandoverPorts,
  params: OwnerCalls['owner.brainHandover.abort']['params'],
): Promise<OwnerCalls['owner.brainHandover.abort']['result']> {
  const record = reconcile(ports.stateDir, params.migrationId)
  if (!record) {
    // A begin that stopped between its claim and its record: release that exact claim.
    if (await releaseOrphanClaim(ports.stateDir, params.migrationId))
      ports.log?.('brain.handover.aborted', { migrationId: params.migrationId })
    return { state: 'none' }
  }
  if (record.state === 'aborted') return { state: 'aborted' }
  if (record.state === 'published' || record.state === 'committed')
    throw refused('The Brain already moved to this Phosphor service.')
  await abandon(ports.stateDir, record)
  ports.log?.('brain.handover.aborted', { migrationId: params.migrationId })
  return { state: 'aborted' }
}

async function status(
  ports: BrainHandoverPorts,
  params: OwnerCalls['owner.brainHandover.status']['params'],
): Promise<OwnerCalls['owner.brainHandover.status']['result']> {
  const claim = liveClaim(ports, false)
  const target = claim ? 'claimed' : targetOccupied(ports.stateDir) ? 'occupied' : 'empty'
  const record = params.migrationId ? reconcile(ports.stateDir, params.migrationId, false) : claim
  return {
    support: {
      handover: supported(ports),
      reader: await ports.readerReadiness().catch(() => 'unavailable' as const),
      target,
    },
    state: stateOf(record),
  }
}

/** The five handlers, serialized: one handover call at a time, in arrival order. */
export function createBrainHandoverHandlers(ports: BrainHandoverPorts): Handlers {
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }
  return {
    // Read-only and idempotent, so it answers while a long verify or commit runs.
    'owner.brainHandover.status': (params) => status(ports, params),
    'owner.brainHandover.begin': (params) => serial(() => begin(ports, params)),
    'owner.brainHandover.verify': (params) => serial(() => verify(ports, params)),
    'owner.brainHandover.commit': (params) => serial(() => commit(ports, params)),
    'owner.brainHandover.abort': (params) => serial(() => abort(ports, params)),
  }
}
