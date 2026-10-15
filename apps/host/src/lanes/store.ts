import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, relative, isAbsolute } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  HOST_LIMITS,
  type LaneControl,
  type LaneController,
  type LaneSummary,
  type Receipt,
  type RepositorySummary,
} from '@phosphor/shared/host-protocol'
import { loadSqlite } from './sqlite'
import { SCHEMA, SCHEMA_VERSION } from './schema'
import { prepareStateDirectory, prepareStateFile, StateFailure } from './state-dir'
import {
  absolutePath,
  canonicalJson,
  check,
  integer,
  JsonTooLarge,
  storedReceipt,
  text,
  uuid,
} from './validation'
export { opHash } from './validation'

export type RepositoryIdentity = {
  home: string
  expected: { path: string; dev: number; ino: number }
}

/** Only newly added folders are home-confined; owner-configured roots remain unrestricted. */
export function validateRepositoryIdentity(identity: RepositoryIdentity): void {
  const { expected } = identity
  const home = realpathSync.native(identity.home)
  const full = realpathSync.native(expected.path)
  const rel = relative(home, full)
  const info = statSync(full)
  check(full === expected.path && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
  check(info.isDirectory() && info.dev === expected.dev && info.ino === expected.ino)
}

export const REMOVED_LANE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RECEIPT_EXPIRED = 'finished_at < ?'

export class LaneCapacityReached extends Error {
  constructor() {
    super('Host lane capacity reached.')
  }
}

export interface StoredLane extends LaneSummary {
  readonly sessionFile: string | null
  readonly removedAt: string | null
}
export interface LanePatch {
  title?: string | null
  branch?: string | null
  provider?: string | null
  model?: string | null
  updatedAt?: string
}
export interface LaneInput extends LanePatch {
  repositoryId: string
  cwd: string
  sessionFile: string | null
  worktree?: boolean
}
export type Controller = Pick<LaneController, 'clientId' | 'label'>
export type Admission =
  | { admitted: true; control: LaneControl }
  | { admitted: false; code: 'stale-fence' | 'not-controller'; control: LaneControl }
export type RequestStart =
  { kind: 'new' } | { kind: 'existing'; receipt: Receipt } | { kind: 'conflict' } | { kind: 'busy' }
export type StoreLimits = {
  [Key in 'receiptsKept' | 'lanesPerHost' | 'repositoriesPerHost']: number
}
export interface StorePorts {
  onLaneRemoved?: (laneId: string) => void
  now?: () => number
  receiptTtlMs?: number
  isConnected?: (clientId: string) => boolean
  limits?: Partial<StoreLimits>
  logCorruptReceipt?: (count: number) => void
  logCorruptLane?: (count: number) => void
}
type Row = Record<string, SQLOutputValue>
function str(row: Row, key: string): string {
  const value = row[key]
  check(typeof value === 'string')
  return value
}
function nullable(row: Row, key: string): string | null {
  const value = row[key]
  check(value === null || typeof value === 'string')
  return value
}
function num(row: Row, key: string): number {
  const raw = row[key]
  check(typeof raw === 'number' || typeof raw === 'bigint')
  const value = Number(raw)
  integer(value)
  return value
}
const iso = (value: number) => new Date(value).toISOString()
function timestamp(value: string): number {
  const parsed = Date.parse(value)
  integer(parsed)
  check(iso(parsed) === value)
  return parsed
}

export async function openStore(
  directory: string,
  uid: number | undefined,
  ports: StorePorts = {},
): Promise<HostStore> {
  let db: DatabaseSync | undefined
  try {
    prepareStateDirectory(directory, uid)
    const path = prepareStateFile(directory, uid)
    const sqlite = await loadSqlite()
    db = new sqlite.DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number' || version > SCHEMA_VERSION)
      throw new StateFailure(directory, 78, 'this state was written by a newer Host')
    const store = new HostStore(db, ports)
    if (version === 0) store.migrate()
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    store.markInterrupted()
    store.pruneReceipts((ports.now ?? Date.now)())
    return store
  } catch (error) {
    db?.close()
    if (error instanceof StateFailure) throw error
    throw new StateFailure(directory, 70, 'Could not open state.sqlite.')
  }
}

/** SQLite is the ordering point. Every mutation obtains its write lock before reading. */
export class HostStore {
  private readonly now: () => number
  private readonly receiptTtlMs: number
  private readonly isConnected: (clientId: string) => boolean
  private readonly logCorruptLane: (count: number) => void
  private readonly logCorruptReceipt: (count: number) => void
  readonly limits: Readonly<StoreLimits>
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
  private control(row: Row): LaneControl {
    const clientId = nullable(row, 'controller_client_id')
    return {
      fence: num(row, 'fence'),
      controller:
        clientId === null
          ? null
          : {
              clientId,
              label: str(row, 'controller_label'),
              connected: this.isConnected(clientId),
            },
    }
  }
  private summaryQuery(sql: string) {
    const query = this.db.prepare(sql)
    // SQLite can hold integers beyond JS's safe range. Read them losslessly
    // so validation can skip that row instead of the driver failing the read.
    query.setReadBigInts(true)
    return query
  }
  private logCorruptRow(): null {
    try {
      this.logCorruptLane(1)
    } catch {
      // A logger failure cannot expose corrupt state or fail a read.
    }
    return null
  }
  private laneFromRow(row: Row): StoredLane | null {
    try {
      const laneId = str(row, 'lane_id')
      uuid(laneId)
      check(laneId[14] === '4')
      const repositoryId = str(row, 'repository_id')
      check(/^[0-9a-f]{16}$/.test(repositoryId))
      const cwd = str(row, 'cwd')
      absolutePath(cwd)
      const sessionFile = nullable(row, 'session_file')
      if (sessionFile !== null) absolutePath(sessionFile)
      const title = nullable(row, 'title')
      const branch = nullable(row, 'branch')
      const provider = nullable(row, 'provider')
      const model = nullable(row, 'model')
      text(title, HOST_LIMITS.labelChars, true)
      text(branch, 256)
      text(provider, 64)
      text(model, 128)
      check((provider === null) === (model === null))
      const worktree = num(row, 'worktree')
      check(worktree === 0 || worktree === 1)
      const created = num(row, 'created_at')
      const updated = num(row, 'updated_at')
      check(updated >= created)
      const attention = num(row, 'attention')
      const read = num(row, 'read')
      check(read <= attention)
      integer(num(row, 'fence'), 1)
      const clientId = nullable(row, 'controller_client_id')
      const label = nullable(row, 'controller_label')
      check((clientId === null) === (label === null))
      if (clientId !== null) uuid(clientId)
      text(label, HOST_LIMITS.labelChars)
      return {
        laneId,
        repositoryId,
        cwd,
        sessionFile,
        title,
        branch,
        worktree: worktree === 1,
        model: provider === null || model === null ? null : { provider, id: model },
        activity: 'stopped',
        createdAt: iso(created),
        updatedAt: iso(updated),
        attention,
        read,
        control: this.control(row),
        removedAt: row.removed_at === null ? null : iso(num(row, 'removed_at')),
      }
    } catch {
      return this.logCorruptRow()
    }
  }
  private repositoryFromRow(row: Row): RepositorySummary | null {
    try {
      const id = str(row, 'id')
      check(/^[0-9a-f]{16}$/.test(id))
      const path = str(row, 'path')
      absolutePath(path)
      const name = str(row, 'name')
      text(name, 4096)
      const active = num(row, 'active')
      check(active === 0 || active === 1)
      iso(num(row, 'added_at'))
      return { id, name, path }
    } catch {
      return this.logCorruptRow()
    }
  }
  listRepositories(): RepositorySummary[] {
    return this.summaryQuery(
      'SELECT * FROM repositories WHERE active=1 ORDER BY added_at,id LIMIT ?',
    )
      .all(this.limits.repositoriesPerHost)
      .flatMap((row) => this.repositoryFromRow(row) ?? [])
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
        if (!statSync(real).isDirectory()) {
          unavailable++
          continue
        }
        absolutePath(real)
        const id = createHash('sha256').update(real).digest('hex').slice(0, 16)
        repositories.set(id, { id, path: real, name: basename(real) })
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
        ))
          throw error
        unavailable++
      }
    }
    const result = this.transaction(() => {
      this.db.prepare('UPDATE repositories SET active=0').run()
      for (const repository of repositories.values())
        this.db
          .prepare(
            `INSERT INTO repositories VALUES (?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET active=1,name=excluded.name`,
          )
          .run(repository.id, repository.path, repository.name, this.clock())
      return this.listRepositories()
    })
    if (unavailable) logUnavailable(unavailable)
    return result
  }
  listLanes(): StoredLane[] {
    return this.summaryQuery(
      'SELECT * FROM lanes WHERE removed_at IS NULL ORDER BY created_at,lane_id LIMIT ?',
    )
      .all(this.limits.lanesPerHost)
      .flatMap((row) => this.laneFromRow(row) ?? [])
  }
  getLane(id: string): StoredLane | null {
    uuid(id)
    const row = this.summaryQuery('SELECT * FROM lanes WHERE lane_id=?').get(id)
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
  ensureLane(input: LaneInput, options: { controller?: Controller } = {}): StoredLane {
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
          : this.summaryQuery('SELECT * FROM lanes WHERE session_file=?').get(sessionFile)
      if (existing) {
        check(str(existing, 'repository_id') === repositoryId && str(existing, 'cwd') === cwd)
        const lane = this.laneFromRow(existing)
        check(lane !== null)
        if (existing.removed_at === null) return lane
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
      if (options.controller !== undefined) this.validateController(options.controller)
      const id = randomUUID()
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
  bindSessionFile(id: string, file: string): void {
    absolutePath(file)
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
    integer(now)
    this.transaction(() => {
      this.db.prepare('DELETE FROM lanes WHERE removed_at < ?').run(now - REMOVED_LANE_TTL_MS)
      this.db
        .prepare(
          `DELETE FROM lanes WHERE lane_id IN (SELECT lane_id FROM lanes WHERE removed_at IS NOT NULL ORDER BY removed_at DESC,lane_id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(this.limits.lanesPerHost)
    })
  }
  private validateController(controller: Controller): void {
    uuid(controller.clientId)
    check(typeof controller.label === 'string')
    text(controller.label, HOST_LIMITS.labelChars)
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
    this.validateController(controller)
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
  admit(id: string, controller: Controller, fence: number): Admission {
    this.validateController(controller)
    integer(fence, 1)
    return this.transaction(() => {
      const control = this.requireLane(id).control
      if (control.fence !== fence) return { admitted: false, code: 'stale-fence', control }
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
  private decodeReceipt(row: Row): Receipt | null {
    try {
      if (row.status === 'started')
        return storedReceipt({ requestId: str(row, 'request_id'), status: 'pending' })
      let value: unknown = JSON.parse(str(row, 'receipt_json'))
      if (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        value.status === 'rejected' &&
        'control' in value
      ) {
        const control = value.control
        if (
          typeof control === 'object' &&
          control !== null &&
          'controller' in control &&
          control.controller !== null
        ) {
          const controller = control.controller
          check(
            typeof controller === 'object' &&
              'clientId' in controller &&
              typeof controller.clientId === 'string' &&
              !('connected' in controller),
          )
          value = {
            ...value,
            control: {
              ...control,
              controller: {
                ...controller,
                connected: this.isConnected(controller.clientId),
              },
            },
          }
        }
      }
      const receipt = storedReceipt(value)
      check(receipt.requestId === str(row, 'request_id') && receipt.status === str(row, 'status'))
      return receipt
    } catch {
      try {
        this.logCorruptReceipt(1)
      } catch {
        // A logger failure cannot turn corrupt state into a caller-visible error.
      }
      return null
    }
  }
  getReceipt(requestId: string, clientId: string): Receipt | null {
    uuid(requestId)
    uuid(clientId)
    const row = this.db
      .prepare(
        `SELECT * FROM receipts WHERE request_id=? AND client_id=? AND (finished_at IS NULL OR NOT (${RECEIPT_EXPIRED}))`,
      )
      .get(requestId, clientId, this.clock() - this.receiptTtlMs)
    return row ? this.decodeReceipt(row) : null
  }
  private serializeReceipt(receipt: Receipt): string {
    if (receipt.status === 'rejected' && receipt.control?.controller) {
      const { connected: _connected, ...controller } = receipt.control.controller
      return canonicalJson({ ...receipt, control: { ...receipt.control, controller } })
    }
    return canonicalJson(receipt)
  }
  beginRequest(
    requestId: string,
    clientId: string,
    hash: string,
    laneId: string | null,
  ): RequestStart {
    uuid(requestId)
    uuid(clientId)
    check(/^[0-9a-f]{64}$/.test(hash))
    if (laneId !== null) uuid(laneId)
    return this.transaction(() => {
      const now = this.clock()
      this.prune(now)
      const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId)
      if (row) {
        const receipt = this.decodeReceipt(row)
        if (row.client_id !== clientId || row.op_hash !== hash || row.lane_id !== laneId)
          return { kind: 'conflict' }
        return {
          kind: 'existing',
          receipt: receipt ?? { requestId, status: 'unknown' },
        }
      }
      if (
        Number(
          this.db.prepare("SELECT count(*) AS count FROM receipts WHERE status='started'").get()
            ?.count,
        ) >= this.limits.receiptsKept
      )
        return { kind: 'busy' }
      this.db
        .prepare("INSERT INTO receipts VALUES (?,?,?,?,'started',NULL,?,NULL)")
        .run(requestId, clientId, hash, laneId, now)
      return { kind: 'new' }
    })
  }
  finishRequest(requestId: string, receipt: Receipt): void {
    uuid(requestId)
    let value = storedReceipt(receipt)
    check(value.requestId === requestId && value.status !== 'pending')
    if (value.status === 'done' && value.data !== undefined) {
      try {
        canonicalJson(value.data, HOST_LIMITS.receiptDataBytes)
      } catch (error) {
        if (!(error instanceof JsonTooLarge)) throw error
        const { data: _data, ...withoutData } = value
        value = withoutData
      }
    }
    const json = this.serializeReceipt(value)
    check(Buffer.byteLength(json) <= HOST_LIMITS.receiptDataBytes + 8192)
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId)
      check(row !== undefined)
      if (row.status !== 'started') {
        check(row.receipt_json === json)
        return
      }
      this.db
        .prepare('UPDATE receipts SET status=?,receipt_json=?,finished_at=? WHERE request_id=?')
        .run(value.status, json, Math.max(this.clock(), num(row, 'started_at')), requestId)
      this.pruneFinishedCount()
    })
  }
  markInterrupted(): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE receipts SET status='unknown',receipt_json=json_object('requestId',request_id,'status','unknown'),finished_at=max(?,started_at) WHERE status='started'`,
        )
        .run(this.clock())
    })
  }
  private pruneFinishedCount(): void {
    this.db
      .prepare(
        `DELETE FROM receipts WHERE request_id IN (SELECT request_id FROM receipts WHERE finished_at IS NOT NULL ORDER BY finished_at DESC,request_id DESC LIMIT -1 OFFSET ?)`,
      )
      .run(this.limits.receiptsKept)
  }
  private prune(now: number): void {
    this.db.prepare(`DELETE FROM receipts WHERE ${RECEIPT_EXPIRED}`).run(now - this.receiptTtlMs)
    this.pruneFinishedCount()
  }
  pruneReceipts(now: number): void {
    integer(now)
    this.transaction(() => this.prune(now))
  }
  /** A bounded read for reconciliation, without exposing the database handle. */
  sessionLane(file: string): StoredLane | null {
    absolutePath(file)
    const row = this.summaryQuery('SELECT * FROM lanes WHERE session_file=?').get(file)
    return row ? this.laneFromRow(row) : null
  }
}
