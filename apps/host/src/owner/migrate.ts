/**
 * `owner.migrate.*`: Desktop moves This Mac's in-app state into this daemon
 * while it waits in standby (reconcile-v1 B4). Begin snapshots the daemon's
 * state, each import applies one section at once (so `owner.index` reads the
 * lanes back) and records its hash, abort puts the begin snapshot back, and
 * commit is THE commit point: durable first, then the standby marker goes,
 * and `run` takes the owner lock and starts its lanes and scheduler.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MigrationImport,
  MigrationSection,
  MigrationState,
  OwnerCalls,
} from '@phosphor/shared/host-protocol-owner'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { readOwnerLock } from '@phosphor/session-runtime/owner-lock/owner-lock'
import { piAgentDir, piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import type { RunContext } from '../commands/run'
import type { LocalDaemon } from '../commands/run-local'
import { loadRunConfig, syncRunRepositories } from '../commands/run-state'
import { hostStateDirectory, prepareStateDirectory } from '../lanes/state-dir'
import type { HostStore } from '../lanes/store'
import { OwnerCallRefused, type OwnerHandler, type OwnerHandlers } from './adapter'
import { ownerIndex } from './index-call'
import type { OwnerSeam } from './socket'
import { withMigrationRecords, type MigrationRecords, type StoredMigration } from './staging'

export type MigrationSectionName = MigrationSection['section']

export interface MigrationImportContext {
  readonly migrationId: string
  /** Begin asked to merge into a daemon that already ran lanes (N12). */
  readonly merge: boolean
  readonly store: HostStore
}

/** One section's importer (P4b). `apply` runs again only after an abort and a new begin. */
export interface MigrationImporter<S extends MigrationSectionName = MigrationSectionName> {
  apply(
    section: Extract<MigrationSection, { section: S }>,
    context: MigrationImportContext,
  ): Promise<void>
  /** At begin: copies into `folder` whatever outside state.sqlite `apply` may change. */
  snapshot?(folder: string): Promise<void>
  /** At abort, before state.sqlite is restored: puts back what `snapshot` copied. */
  restore?(folder: string): Promise<void>
}
export type MigrationImporters = { readonly [S in MigrationSectionName]?: MigrationImporter<S> }

export interface OwnerMigrationPorts {
  stateDirectory: string
  uid: number | undefined
  store: HostStore
  daemon: Pick<LocalDaemon, 'standby' | 'leaveStandby'>
  importers: MigrationImporters
  /** Re-reads the config and the store's folders once abort has put them back. */
  refresh(): Promise<void>
  now(): number
  log(event: string, fields?: Record<string, unknown>): void
}

type MigrateMethod =
  | 'owner.migrate.begin'
  | 'owner.migrate.import'
  | 'owner.migrate.status'
  | 'owner.migrate.commit'
  | 'owner.migrate.abort'
export type OwnerMigrateHandlers = { readonly [M in MigrateMethod]: OwnerHandler<M> }

/** Fixed texts Desktop may rely on; M3 tells "another id" from "this id" through status. */
export const MIGRATION_REFUSALS = {
  notStandby: 'The Phosphor service is not in standby.',
  otherStaged: 'Another migration is staged.',
  notStaged: 'No migration with this id is staged.',
  aborted: 'This migration was aborted. Begin a new one.',
  committed: 'This migration is committed and cannot be aborted.',
  restaged: 'This section is already staged with different content. Abort and begin again.',
  noImporter: 'This Phosphor service cannot import this section yet.',
} as const

const refuse = (message: string) => new OwnerCallRefused('forbidden', message)

/** `<state>/owner-migration/<id>`: the begin snapshot, removed at commit and abort. */
const SNAPSHOTS = 'owner-migration'

export function createOwnerMigration(ports: OwnerMigrationPorts) {
  const folderOf = (id: string) => join(ports.stateDirectory, SNAPSHOTS, id)
  const records = <T>(fn: (records: MigrationRecords) => T) =>
    withMigrationRecords(ports.stateDirectory, ports.uid, ports.now, fn)
  let queue: Promise<unknown> = Promise.resolve()
  /** One migration call at a time, in arrival order; a failure never blocks the next. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }
  const requireStandby = () => {
    if (!ports.daemon.standby()) throw refuse(MIGRATION_REFUSALS.notStandby)
  }
  async function stagedRow(id: string): Promise<StoredMigration> {
    const row = await records((r) => r.get(id))
    if (row?.state !== 'staged') throw refuse(MIGRATION_REFUSALS.notStaged)
    requireStandby()
    return row
  }
  /** Removes the marker after a durable commit and records that it went. */
  async function rollForward(row: StoredMigration) {
    if (ports.daemon.standby()) await ports.daemon.leaveStandby()
    await records((r) => r.markLeft(row))
    ports.log('owner.migrate.rolled_forward', { migrationId: row.migrationId })
  }
  const removeSnapshot = (id: string) => rm(folderOf(id), { recursive: true, force: true })

  async function begin(
    params: OwnerCalls['owner.migrate.begin']['params'],
  ): Promise<{ state: MigrationState }> {
    const existing = await records((r) => r.get(params.migrationId))
    if (existing) return { state: existing.state }
    requireStandby()
    if ((await records((r) => r.inState('staged'))).length > 0)
      throw refuse(MIGRATION_REFUSALS.otherStaged)
    const folder = folderOf(params.migrationId)
    await removeSnapshot(params.migrationId)
    prepareStateDirectory(folder, ports.uid)
    await records((r) => r.snapshot(join(folder, 'state.sqlite')))
    for (const [section, importer] of Object.entries(ports.importers)) {
      if (!importer.snapshot) continue
      prepareStateDirectory(join(folder, section), ports.uid)
      await importer.snapshot(join(folder, section))
    }
    const migration = {
      migrationId: params.migrationId,
      desktopVersion: params.desktopVersion,
      merge: params.merge === true,
    }
    await records((r) => r.begin(migration))
    ports.log('owner.migrate.begun', { migrationId: params.migrationId, merge: migration.merge })
    return { state: 'staged' }
  }

  async function importSection(
    params: MigrationImport,
  ): Promise<OwnerCalls['owner.migrate.import']['result']> {
    const row = await stagedRow(params.migrationId)
    const { migrationId, hash, ...section } = params
    const payload = JSON.stringify(section)
    const staged = await records((r) => r.staged(migrationId, section.section))
    if (staged) {
      if (staged.digest === hash && staged.payload === payload)
        return { staged: true, replayed: true }
      throw refuse(MIGRATION_REFUSALS.restaged)
    }
    const importer = ports.importers[section.section] as MigrationImporter | undefined
    if (!importer) throw new OwnerCallRefused('unsupported', MIGRATION_REFUSALS.noImporter)
    await importer.apply(section, { migrationId, merge: row.merge, store: ports.store })
    await records((r) => r.stage(migrationId, section.section, { digest: hash, payload }))
    return { staged: true, replayed: false }
  }

  async function commit(
    params: OwnerCalls['owner.migrate.commit']['params'],
  ): Promise<{ state: 'committed' }> {
    let row = await records((r) => r.get(params.migrationId))
    if (row?.state === 'aborted') throw refuse(MIGRATION_REFUSALS.aborted)
    if (row?.state !== 'committed') {
      const staged = await stagedRow(params.migrationId)
      await records((r) => r.commit(staged))
      ports.log('owner.migrate.committed', { migrationId: staged.migrationId })
      row = { ...staged, state: 'committed', left: false }
    }
    if (!row.left) await rollForward(row)
    await removeSnapshot(row.migrationId)
    return { state: 'committed' }
  }

  async function abort(
    params: OwnerCalls['owner.migrate.abort']['params'],
  ): Promise<{ state: 'aborted' | 'none' }> {
    const row = await records((r) => r.get(params.migrationId))
    if (!row) return { state: 'none' }
    if (row.state === 'aborted') return { state: 'aborted' }
    if (row.state === 'committed') throw refuse(MIGRATION_REFUSALS.committed)
    requireStandby()
    const folder = folderOf(row.migrationId)
    for (const [section, importer] of Object.entries(ports.importers))
      if (importer.restore) await importer.restore(join(folder, section))
    await records((r) => r.restore(join(folder, 'state.sqlite'), row))
    ports.log('owner.migrate.aborted', { migrationId: row.migrationId })
    await ports.refresh().catch(() => ports.log('owner.migrate.refresh_failed'))
    await removeSnapshot(row.migrationId)
    return { state: 'aborted' }
  }

  /**
   * At start: a commit whose marker survived a crash rolls forward, and a
   * snapshot folder without a staged row (a crashed begin, commit or abort) goes.
   */
  async function recover(): Promise<void> {
    for (const row of await records((r) => r.inState('committed')))
      if (!row.left) await rollForward(row)
    const staged = new Set((await records((r) => r.inState('staged'))).map((r) => r.migrationId))
    let names: string[] = []
    try {
      names = await readdir(join(ports.stateDirectory, SNAPSHOTS))
    } catch (error) {
      if (!errnoIs(error, 'ENOENT')) throw error
    }
    for (const name of names) if (!staged.has(name)) await removeSnapshot(name)
  }

  const handlers: OwnerMigrateHandlers = {
    'owner.migrate.begin': (params) => serial(() => begin(params)),
    'owner.migrate.import': (params) => serial(() => importSection(params)),
    'owner.migrate.status': (params) =>
      serial(async () => ({
        state: (await records((r) => r.get(params.migrationId)))?.state ?? 'none',
      })),
    'owner.migrate.commit': (params) => serial(() => commit(params)),
    'owner.migrate.abort': (params) => serial(() => abort(params)),
  }
  return { handlers, recover: () => serial(recover) }
}

/**
 * `owner.index` and `owner.migrate.*` for the owner socket. Built once the
 * store is open, before the socket binds, so a commit a crash interrupted
 * rolls forward before `run` checks for standby.
 */
export function migrationOwnerHandlers(context: RunContext, importers: MigrationImporters = {}) {
  return async ({ daemon, store, machineId }: OwnerSeam): Promise<OwnerHandlers> => {
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      context.log?.('host', event, fields)
    const migration = createOwnerMigration({
      stateDirectory: hostStateDirectory(context.env, context.home),
      uid: context.uid,
      store,
      daemon,
      importers,
      refresh: async () => syncRunRepositories(context, store, await loadRunConfig(context)),
      now: context.now ?? Date.now,
      log,
    })
    // A failed roll-forward leaves the daemon in standby; the next commit call retries it.
    await migration.recover().catch(() => log('owner.migrate.recover_failed'))
    const agentDir = piAgentDir(context.env, context.home)
    const index = {
      machineId,
      agentDir,
      sessionsRoot: piSessionsRoot(context.env, context.home),
      daemon,
      store,
      ownerLock: () => readOwnerLock(agentDir, context.uid),
      pid: process.pid,
    }
    return { ...migration.handlers, 'owner.index': (params) => ownerIndex(index, params) }
  }
}
