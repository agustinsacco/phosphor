/**
 * The owner protocol: `call` methods served only on a machine's local socket,
 * ahead of the lane adapter, so they work in standby with no lane service. Every
 * method is a call: mutations are idempotent by their key (`migrationId`,
 * `leaseId`, `accountId`, `action`), long work answers at once and is observed
 * through `machine.local`, and no token ever lands in a receipt. A TCP grant
 * connection never reaches one; an older Host answers `unsupported`.
 *
 * Pure module. Living contract: docs/remote-protocol.md ("Owner calls").
 */
import { record } from './host-protocol/primitives'
import { parseMigrationImport, type MigrationImport } from './host-protocol-owner/migration'
import {
  brainHandoverBeginParams,
  brainHandoverStatusParams,
  brainHandoverVerifyParams,
  type BrainHandoverBegin,
  type BrainHandoverReport,
  type BrainHandoverState,
  type BrainHandoverSupport,
  type BrainHandoverVerify,
} from './host-protocol-owner/brain-handover'
import {
  accountRef,
  accountRegistration,
  action,
  appService,
  beginParams,
  indexParams,
  leaseRef,
  leaseTakeParams,
  migrationRef,
  noParams,
  pauseParams,
  transcriptParams,
  type AccountRegistration,
} from './host-protocol-owner/params'
import type {
  AppServiceRegistration,
  LeaseRefusal,
  LocalMode,
  LocalStatus,
  MigrationState,
  OwnerAccountFolder,
  OwnerIndex,
  OwnerLockStatus,
  OwnerTranscriptPage,
  ServicePauseState,
} from './host-protocol-owner/status'

export type {
  AppServiceRegistration,
  LeaseRefusal,
  LocalMode,
  LocalStatus,
  MigrationState,
  OwnerAccountFolder,
  OwnerIndex,
  OwnerLaneRow,
  OwnerLockStatus,
  OwnerTranscriptPage,
  ServicePauseState,
} from './host-protocol-owner/status'
export {
  MIGRATION_LIMITS,
  parseMigrationImport,
  parseMigrationFolders,
} from './host-protocol-owner/migration'
export type {
  MigrationArchiveManifest,
  MigrationImport,
  MigrationLaneItem,
  MigrationSection,
} from './host-protocol-owner/migration'
export { OWNER_LIMITS } from './host-protocol-owner/params'
export { BRAIN_HANDOVER_LIMITS, isBrainHandoverName } from './host-protocol-owner/brain-handover'
export type {
  BrainHandoverBegin,
  BrainHandoverFile,
  BrainHandoverReport,
  BrainHandoverState,
  BrainHandoverSupport,
  BrainHandoverVerify,
  BrainReaderReadiness,
} from './host-protocol-owner/brain-handover'
export type { AccountRegistration } from './host-protocol-owner/params'

export const OWNER_METHODS = [
  'machine.local',
  'machine.identity.reload',
  'machine.enroll',
  'machine.owner',
  'machine.pause',
  'app.service.register',
  'headroom.status',
  'headroom.set',
  'owner.index',
  'owner.migrate.begin',
  'owner.migrate.import',
  'owner.migrate.status',
  'owner.migrate.commit',
  'owner.migrate.abort',
  'owner.lease.take',
  'owner.lease.renew',
  'owner.lease.release',
  'owner.transcript.page',
  'owner.account.prepare',
  'owner.account.register',
  'owner.account.discard',
  'owner.brainHandover.pin',
  'owner.brainHandover.status',
  'owner.brainHandover.begin',
  'owner.brainHandover.verify',
  'owner.brainHandover.commit',
  'owner.brainHandover.abort',
] as const
export type OwnerMethod = (typeof OWNER_METHODS)[number]

/** Admitted for any socket principal. Every other method needs `principal.kind === 'owner'`. */
export const OWNER_METHODS_ANY_LOCAL = [
  'machine.local',
  'machine.identity.reload',
  'headroom.status',
] as const satisfies readonly OwnerMethod[]

interface Call<P, R> {
  params: P
  result: R
}
export interface OwnerCalls {
  'machine.local': Call<undefined, LocalStatus>
  'machine.identity.reload': Call<undefined, { mode: LocalMode }>
  /** Refused while the standby marker exists. */
  'machine.enroll': Call<
    { action: 'begin' | 'cancel' },
    { userCode: string; fingerprint: string; expiresAt: string } | { cancelled: true }
  >
  'machine.owner': Call<{ action: 'acquire' | 'release' }, OwnerLockStatus>
  'machine.pause': Call<
    | { action: 'begin'; purpose: 'update'; deadlineMs?: number }
    | { action: 'abort-now' }
    | { action: 'cancel' },
    ServicePauseState
  >
  'app.service.register': Call<AppServiceRegistration, { registered: true }>
  'headroom.status': Call<
    undefined,
    { enabled: boolean; state: 'off' | 'starting' | 'ready' | 'failed' }
  >
  'headroom.set': Call<{ enabled: boolean }, { enabled: boolean }>
  'owner.index': Call<{ after?: string }, OwnerIndex>
  'owner.migrate.begin': Call<
    { migrationId: string; desktopVersion: string; merge?: true },
    { state: MigrationState }
  >
  'owner.migrate.import': Call<MigrationImport, { staged: true; replayed: boolean }>
  'owner.migrate.status': Call<{ migrationId: string }, { state: MigrationState }>
  'owner.migrate.commit': Call<{ migrationId: string }, { state: 'committed' }>
  'owner.migrate.abort': Call<{ migrationId: string }, { state: 'aborted' | 'none' }>
  'owner.lease.take': Call<
    { paths: string[]; ttlMs: number },
    { leaseId: string } | { refused: LeaseRefusal; path: string }
  >
  'owner.lease.renew': Call<{ leaseId: string }, { ok: boolean }>
  'owner.lease.release': Call<{ leaseId: string }, { ok: true }>
  'owner.transcript.page': Call<
    { laneId: string; offset: number; maxBytes?: number },
    OwnerTranscriptPage
  >
  'owner.account.prepare': Call<undefined, OwnerAccountFolder>
  /** The daemon registers the folder it issued for `accountId`; no path is accepted. */
  'owner.account.register': Call<AccountRegistration, { registered: true }>
  /** A login the user cancelled: removes the prepared folder if it holds no account. */
  'owner.account.discard': Call<{ accountId: string }, { discarded: boolean }>
  /** Pin this installed Host to compatible updates before releasing the previous writer. */
  'owner.brainHandover.pin': Call<undefined, { pinned: true }>
  /** Without an id: whether a move can start. With one: that move's state. */
  'owner.brainHandover.status': Call<
    { migrationId?: string },
    { support: BrainHandoverSupport; state: BrainHandoverState }
  >
  /** Claims the empty Brain target and creates the private staging folder it returns. */
  'owner.brainHandover.begin': Call<BrainHandoverBegin, { state: 'staged'; staging: string }>
  /** Seals the staged files named here, upgrades and checks the sealed copy. */
  'owner.brainHandover.verify': Call<
    BrainHandoverVerify,
    { state: 'verified'; report: BrainHandoverReport }
  >
  /** Publishes the verified copy as the service's Brain; idempotent by id. */
  'owner.brainHandover.commit': Call<{ migrationId: string }, { state: 'committed' }>
  /** Refused once published: the service owns the Brain from then on. */
  'owner.brainHandover.abort': Call<{ migrationId: string }, { state: 'aborted' | 'none' }>
}

export function isOwnerMethod(m: string): m is OwnerMethod {
  return OWNER_METHODS.some((method) => method === m)
}
export function isAnyLocalOwnerMethod(m: OwnerMethod): boolean {
  return OWNER_METHODS_ANY_LOCAL.some((method) => method === m)
}

type ParamParsers = { [M in OwnerMethod]: (v: unknown) => OwnerCalls[M]['params'] | null }
const enabled = (v: unknown): { enabled: boolean } | null =>
  record(v) && typeof v.enabled === 'boolean' ? { enabled: v.enabled } : null

const PARAMS: ParamParsers = {
  'machine.local': noParams,
  'machine.identity.reload': noParams,
  'machine.enroll': (v) => action(v, ['begin', 'cancel'] as const),
  'machine.owner': (v) => action(v, ['acquire', 'release'] as const),
  'machine.pause': pauseParams,
  'app.service.register': appService,
  'headroom.status': noParams,
  'headroom.set': enabled,
  'owner.index': indexParams,
  'owner.migrate.begin': beginParams,
  'owner.migrate.import': parseMigrationImport,
  'owner.migrate.status': migrationRef,
  'owner.migrate.commit': migrationRef,
  'owner.migrate.abort': migrationRef,
  'owner.lease.take': leaseTakeParams,
  'owner.lease.renew': leaseRef,
  'owner.lease.release': leaseRef,
  'owner.transcript.page': transcriptParams,
  'owner.account.prepare': noParams,
  'owner.account.register': accountRegistration,
  'owner.account.discard': accountRef,
  'owner.brainHandover.pin': noParams,
  'owner.brainHandover.status': brainHandoverStatusParams,
  'owner.brainHandover.begin': brainHandoverBeginParams,
  'owner.brainHandover.verify': brainHandoverVerifyParams,
  'owner.brainHandover.commit': migrationRef,
  'owner.brainHandover.abort': migrationRef,
}

/** The method's params, or null when invalid. `undefined` is a valid result for paramless methods. */
export function parseOwnerParams<M extends OwnerMethod>(
  m: M,
  v: unknown,
): OwnerCalls[M]['params'] | null {
  const parse: (v: unknown) => OwnerCalls[M]['params'] | null = PARAMS[m]
  return parse(v)
}
