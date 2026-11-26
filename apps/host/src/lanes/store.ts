import { FolderRows } from './store/folder-rows'
import { randomUUID } from 'node:crypto'
import { repositoryIdForPath } from '@phosphor/session-runtime/host-local/repository-id'
import { realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  HOST_LIMITS,
  type LaneControl,
  type Receipt,
  type RepositorySummary,
} from '@phosphor/shared/host-protocol'
import type { LaneMarksChange } from '@phosphor/shared/host-protocol-lane-marks'
import { SCHEMA } from './schema'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { openStoreDatabase } from './store/open'
import { validateRepositoryIdentity } from './store/identity'
import { LANE_SELECT, writeLaneMarks } from './store/marks'
import { LaneArchiveRows, pruneRemoved } from './store/archives'
import { LanePauseRows } from './store/pauses'
import { composerWindows } from './store/composer-window'
import {
  laneFromRow,
  repositoryFromRow,
  summaryQuery,
  str,
  timestamp,
  type Row,
} from './store/rows'
import {
  LaneCapacityReached,
  type RepositoryIdentity,
  type StoredLane,
  type LanePatch,
  type LaneInput,
  type Controller,
  type Admission,
  type RequestStart,
  type StoreLimits,
  type StorePorts,
} from './store/types'
import * as receipts from './store/receipts'
import { absolutePath, check, integer, text, uuid, validateController } from './validation'
export * from './store/types'
export { opHash } from './validation'
export { validateRepositoryIdentity } from './store/identity'
export { REMOVED_LANE_TTL_MS } from './store/archives'
export function openStore(directory: string, uid: number | undefined, ports: StorePorts = {}) {
  return openStoreDatabase(directory, uid, ports, (db, options) => new HostStore(db, options))
}
/** SQLite is the ordering point. Every mutation obtains its write lock before reading. */
export class HostStore {
  private readonly now: () => number
  private readonly receiptTtlMs: number
  private readonly isConnected: (clientId: string) => boolean
  private readonly logCorruptLane: (count: number) => void
  private readonly logCorruptReceipt: (count: number) => void
  private configOrder: Record<string, number> = {} // Config positions: the listing order.
  readonly limits: Readonly<StoreLimits>
  readonly archives: LaneArchiveRows
  readonly folders: FolderRows
  readonly pauses: LanePauseRows
  readonly composerWindows: ReturnType<typeof composerWindows>
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: StorePorts,
  ) {
    this.receiptTtlMs = ports.receiptTtlMs ?? HOST_LIMITS.receiptTtlMs
    integer(this.receiptTtlMs, 1)
    check(this.receiptTtlMs <= HOST_LIMITS.receiptTtlMs)
    this.now = ports.now ?? Date.now
    this.isConnected = ports.isConnected ?? (() => false)
    this.logCorruptLane = ports.logCorruptLane ?? (() => {})
    this.logCorruptReceipt = ports.logCorruptReceipt ?? (() => {})
    const limits = {
      receiptsKept: HOST_LIMITS.receiptsKept,
      lanesPerHost: HOST_LIMITS.lanesPerHost,
      repositoriesPerHost: HOST_LIMITS.repositoriesPerHost,
      ...ports.limits,
    }
    for (const [key, value] of Object.entries(limits)) {
      check(key === 'receiptsKept' || key === 'lanesPerHost' || key === 'repositoriesPerHost')
      integer(value, 1)
      check(value <= HOST_LIMITS[key])
    }
    this.limits = Object.freeze(limits)
    this.archives = new LaneArchiveRows(db, this.now, limits.lanesPerHost)
    this.folders = new FolderRows(db)
    this.pauses = new LanePauseRows(db)
    this.composerWindows = composerWindows(db)
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  migrate(): void {
    this.transaction(() => this.db.exec(SCHEMA))
  }
  close(): void {
    this.db.close()
  }
  private clock(): number {
    const now = this.now()
    integer(now)
    return now
  }
  private laneFromRow(row: Row): StoredLane | null {
    return laneFromRow(row, { isConnected: this.isConnected, logCorruptLane: this.logCorruptLane })
  }
  listRepositories(): RepositorySummary[] {
    return summaryQuery(
      this.db,
      'SELECT * FROM repositories WHERE active=1 ORDER BY added_at,id LIMIT ?',
    )
      .all(this.limits.repositoriesPerHost)
      .flatMap((row) => repositoryFromRow(row, this.logCorruptLane) ?? [])
      .sort((a, b) => (this.configOrder[a.id] ?? 64) - (this.configOrder[b.id] ?? 64))
  }
  syncRepositories(
    paths: readonly string[],
    logUnavailable: (count: number) => void = () => {},
    identity?: RepositoryIdentity,
  ): RepositorySummary[] {
    if (identity) validateRepositoryIdentity(identity)
    check(paths.length <= this.limits.repositoriesPerHost)
    const repositories = new Map<string, RepositorySummary>()
    let unavailable = 0
    for (const path of paths) {
      absolutePath(path)
      try {
        const real = realpathSync.native(path)
        if (real === '/' || !statSync(real).isDirectory()) {
          unavailable++
          continue
        }
        absolutePath(real)
        const id = repositoryIdForPath(real)
        repositories.set(id, { id, path: real, name: basename(real) })
      } catch (error) {
        if (!(error instanceof Error && errnoIs(error, 'ENOENT', 'ENOTDIR', 'EACCES'))) throw error
        unavailable++
      }
    }
    this.transaction(() => {
      this.db.prepare('UPDATE repositories SET active=0').run()
      for (const repository of repositories.values())
        this.db
          .prepare(
            `INSERT INTO repositories VALUES (?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET active=1,name=excluded.name`,
          )
          .run(repository.id, repository.path, repository.name, this.clock())
    })
    this.configOrder = Object.fromEntries([...repositories.keys()].map((id, i) => [id, i]))
    if (unavailable) logUnavailable(unavailable)
    return this.listRepositories()
  }
  listLanes(): StoredLane[] {
    return summaryQuery(
      this.db,
      `${LANE_SELECT} WHERE removed_at IS NULL ORDER BY created_at,lane_id LIMIT ?`,
    )
      .all(this.limits.lanesPerHost)
      .flatMap((row) => this.laneFromRow(row) ?? [])
  }
  getLane(id: string): StoredLane | null {
    uuid(id)
    const row = summaryQuery(this.db, `${LANE_SELECT} WHERE lane_id=?`).get(id)
    return row ? this.laneFromRow(row) : null
  }
  private requireLane(id: string): StoredLane {
    const lane = this.getLane(id)
    check(lane !== null && lane.removedAt === null)
    return lane
  }
  private validatePatch(patch: LanePatch): void {
    check(
      Object.keys(patch).every((key) =>
        ['title', 'branch', 'provider', 'model', 'updatedAt'].includes(key),
      ),
    )
    if (patch.title !== undefined) text(patch.title, HOST_LIMITS.labelChars, true)
    if (patch.branch !== undefined) text(patch.branch, 256)
    if (patch.provider !== undefined) text(patch.provider, 64)
    if (patch.model !== undefined) text(patch.model, 128)
    if (patch.updatedAt !== undefined) timestamp(patch.updatedAt)
  }
  ensureLane(
    input: LaneInput,
    options: { controller?: Controller; restoreId?: string } = {},
  ): StoredLane {
    check(/^[0-9a-f]{16}$/.test(input.repositoryId))
    absolutePath(input.cwd)
    if (input.sessionFile !== null) absolutePath(input.sessionFile)
    check(input.worktree === undefined || typeof input.worktree === 'boolean')
    const { repositoryId, cwd, sessionFile, worktree, ...patch } = input
    this.validatePatch(patch)
    check(((input.provider ?? null) === null) === ((input.model ?? null) === null))
    return this.transaction(() => {
      const existing =
        sessionFile === null
          ? undefined
          : summaryQuery(this.db, `${LANE_SELECT} WHERE session_file=?`).get(sessionFile)
      if (existing) {
        check(str(existing, 'repository_id') === repositoryId && str(existing, 'cwd') === cwd)
        const lane = this.laneFromRow(existing)
        check(lane !== null)
        if (existing.removed_at === null || this.archives.has(lane.laneId)) return lane
      }
      check(
        this.db.prepare('SELECT id FROM repositories WHERE id=? AND active=1').get(repositoryId) !==
          undefined,
      )
      if (
        Number(
          this.db.prepare('SELECT count(*) AS count FROM lanes WHERE removed_at IS NULL').get()
            ?.count,
        ) >= this.limits.lanesPerHost
      )
        throw new LaneCapacityReached()
      if (existing) {
        this.db
          .prepare('UPDATE lanes SET removed_at=NULL WHERE lane_id=?')
          .run(str(existing, 'lane_id'))
        return this.requireLane(str(existing, 'lane_id'))
      }
      if (options.controller !== undefined) validateController(options.controller)
      const id = options.restoreId ?? randomUUID()
      uuid(id)
      const now = this.clock()
      this.db
        .prepare(`INSERT INTO lanes VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,0,0,NULL)`)
        .run(
          id,
          repositoryId,
          cwd,
          sessionFile,
          input.title ?? null,
          input.branch ?? null,
          worktree ? 1 : 0,
          input.provider ?? null,
          input.model ?? null,
          now,
          input.updatedAt === undefined ? now : timestamp(input.updatedAt),
          options.controller?.clientId ?? null,
          options.controller?.label ?? null,
        )
      return this.requireLane(id)
    })
  }
  bindSessionFile(id: string, file: string | null): void {
    if (file !== null) absolutePath(file)
    this.requireLane(id)
    this.db.prepare('UPDATE lanes SET session_file=? WHERE lane_id=?').run(file, id)
  }
  updateLane(id: string, patch: LanePatch): StoredLane {
    this.validatePatch(patch)
    return this.transaction(() => {
      const lane = this.requireLane(id)
      const provider =
        patch.provider === undefined ? (lane.model?.provider ?? null) : patch.provider
      const model = patch.model === undefined ? (lane.model?.id ?? null) : patch.model
      check((provider === null) === (model === null))
      this.db
        .prepare(
          'UPDATE lanes SET title=?,branch=?,provider=?,model=?,updated_at=? WHERE lane_id=?',
        )
        .run(
          patch.title === undefined ? lane.title : patch.title,
          patch.branch === undefined ? lane.branch : patch.branch,
          provider,
          model,
          patch.updatedAt === undefined
            ? Math.max(this.clock(), timestamp(lane.updatedAt))
            : timestamp(patch.updatedAt),
          id,
        )
      return this.requireLane(id)
    })
  }
  markRemoved(id: string): void {
    uuid(id)
    this.transaction(() =>
      this.db
        .prepare('UPDATE lanes SET removed_at=? WHERE lane_id=? AND removed_at IS NULL')
        .run(this.clock(), id),
    )
    this.ports.onLaneRemoved?.(id)
  }
  pruneRemovedLanes(now: number = this.clock()): void {
    this.transaction(() => pruneRemoved(this.db, now, this.limits.lanesPerHost))
  }
  private setControl(id: string, controller: Controller | null): LaneControl {
    this.db
      .prepare(
        'UPDATE lanes SET fence=fence+1,controller_client_id=?,controller_label=? WHERE lane_id=?',
      )
      .run(controller?.clientId ?? null, controller?.label ?? null, id)
    return this.requireLane(id).control
  }
  takeControl(id: string, controller: Controller): LaneControl {
    validateController(controller)
    return this.transaction(() => {
      this.requireLane(id)
      return this.setControl(id, controller)
    })
  }
  releaseControl(id: string, clientId: string): { released: boolean; control: LaneControl } {
    uuid(clientId)
    return this.transaction(() => {
      const control = this.requireLane(id).control
      if (control.controller?.clientId !== clientId) return { released: false, control }
      return { released: true, control: this.setControl(id, null) }
    })
  }
  admit(id: string, controller: Controller, fence: number | 'if-unheld'): Admission {
    validateController(controller)
    if (fence !== 'if-unheld') integer(fence, 1)
    return this.transaction(() => {
      const control = this.requireLane(id).control
      if (fence === 'if-unheld' && control.controller)
        return { admitted: false, code: 'not-controller', control }
      if (fence !== 'if-unheld' && control.fence !== fence)
        return { admitted: false, code: 'stale-fence', control }
      if (control.controller === null)
        return { admitted: true, control: this.setControl(id, controller) }
      if (control.controller.clientId !== controller.clientId)
        return { admitted: false, code: 'not-controller', control }
      return { admitted: true, control }
    })
  }
  bumpAttention(id: string): number {
    return this.transaction(() => {
      this.requireLane(id)
      this.db.prepare('UPDATE lanes SET attention=attention+1 WHERE lane_id=?').run(id)
      return this.requireLane(id).attention
    })
  }
  /** Pin and marker only: never updatedAt, control or the attention counters. */
  setLaneMarks(id: string, change: LaneMarksChange): StoredLane {
    return this.transaction(() => {
      writeLaneMarks(this.db, this.requireLane(id), change)
      return this.requireLane(id)
    })
  }
  markRead(id: string, upTo: number): number {
    integer(upTo)
    return this.transaction(() => {
      this.requireLane(id)
      this.db
        .prepare('UPDATE lanes SET read=max(read,min(?,attention)) WHERE lane_id=?')
        .run(upTo, id)
      return this.requireLane(id).read
    })
  }
  private receiptContext(): receipts.ReceiptStoreContext {
    return {
      db: this.db,
      transaction: (fn) => this.transaction(fn),
      clock: () => this.clock(),
      limits: this.limits,
      ttl: this.receiptTtlMs,
      isConnected: this.isConnected,
      logCorruptReceipt: this.logCorruptReceipt,
    }
  }
  getReceipt(requestId: string, clientId: string): Receipt | null {
    return receipts.getReceipt(this.receiptContext(), requestId, clientId)
  }
  beginRequest(
    requestId: string,
    clientId: string,
    hash: string,
    laneId: string | null,
  ): RequestStart {
    return receipts.beginRequest(this.receiptContext(), requestId, clientId, hash, laneId)
  }
  finishRequest(requestId: string, receipt: Receipt): void {
    receipts.finishRequest(this.receiptContext(), requestId, receipt)
  }
  markInterrupted(): void {
    receipts.markInterrupted(this.receiptContext())
  }
  pruneReceipts(now: number): void {
    receipts.pruneReceipts(this.receiptContext(), now)
  }
  /** A bounded read for reconciliation, without exposing the database handle. */
  sessionLane(file: string): StoredLane | null {
    absolutePath(file)
    const row = summaryQuery(this.db, `${LANE_SELECT} WHERE session_file=?`).get(file)
    return row ? this.laneFromRow(row) : null
  }
}
