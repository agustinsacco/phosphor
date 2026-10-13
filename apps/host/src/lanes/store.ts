import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
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
  { kind: 'new' } | { kind: 'existing'; receipt: Receipt } | { kind: 'conflict' }
export interface StorePorts {
  now?: () => number
  isConnected?: (clientId: string) => boolean
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
  const value = row[key]
  check(typeof value === 'number')
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
  private readonly isConnected: (clientId: string) => boolean
  constructor(
    private readonly db: DatabaseSync,
    ports: StorePorts,
  ) {
    this.now = ports.now ?? Date.now
    this.isConnected = ports.isConnected ?? (() => false)
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
  private lane(row: Row): StoredLane {
    const provider = nullable(row, 'provider')
    return {
      laneId: str(row, 'lane_id'),
      repositoryId: str(row, 'repository_id'),
      cwd: str(row, 'cwd'),
      sessionFile: nullable(row, 'session_file'),
      title: nullable(row, 'title'),
      branch: nullable(row, 'branch'),
      worktree: num(row, 'worktree') === 1,
      model: provider === null ? null : { provider, id: str(row, 'model') },
      activity: 'stopped',
      createdAt: iso(num(row, 'created_at')),
      updatedAt: iso(num(row, 'updated_at')),
      attention: num(row, 'attention'),
      read: num(row, 'read'),
      control: this.control(row),
      removedAt: row.removed_at === null ? null : iso(num(row, 'removed_at')),
    }
  }
  listRepositories(): RepositorySummary[] {
    return this.db
      .prepare('SELECT * FROM repositories WHERE active=1 ORDER BY added_at,id LIMIT ?')
      .all(HOST_LIMITS.repositoriesPerHost)
      .map((row) => ({ id: str(row, 'id'), name: str(row, 'name'), path: str(row, 'path') }))
  }
  syncRepositories(paths: readonly string[]): RepositorySummary[] {
    check(paths.length <= HOST_LIMITS.repositoriesPerHost)
    const repositories = new Map<string, RepositorySummary>()
    for (const path of paths) {
      absolutePath(path)
      const real = realpathSync.native(path)
      check(statSync(real).isDirectory())
      absolutePath(real)
      const id = createHash('sha256').update(real).digest('hex').slice(0, 16)
      repositories.set(id, { id, path: real, name: basename(real) })
    }
    return this.transaction(() => {
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
  }
  listLanes(): StoredLane[] {
    return this.db
      .prepare('SELECT * FROM lanes WHERE removed_at IS NULL ORDER BY created_at,lane_id LIMIT ?')
      .all(HOST_LIMITS.lanesPerHost)
      .map((row) => this.lane(row))
  }
  getLane(id: string): StoredLane | null {
    uuid(id)
    const row = this.db.prepare('SELECT * FROM lanes WHERE lane_id=?').get(id)
    return row ? this.lane(row) : null
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
  ensureLane(input: LaneInput): StoredLane {
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
          : this.db.prepare('SELECT * FROM lanes WHERE session_file=?').get(sessionFile)
      if (existing) {
        check(str(existing, 'repository_id') === repositoryId && str(existing, 'cwd') === cwd)
        if (existing.removed_at === null) return this.lane(existing)
      }
      check(
        this.db.prepare('SELECT id FROM repositories WHERE id=? AND active=1').get(repositoryId) !==
          undefined,
      )
      check(
        Number(
          this.db.prepare('SELECT count(*) AS count FROM lanes WHERE removed_at IS NULL').get()
            ?.count,
        ) < HOST_LIMITS.lanesPerHost,
      )
      if (existing) {
        this.db
          .prepare('UPDATE lanes SET removed_at=NULL WHERE lane_id=?')
          .run(str(existing, 'lane_id'))
        return this.requireLane(str(existing, 'lane_id'))
      }
      const id = randomUUID()
      const now = this.clock()
      this.db
        .prepare(`INSERT INTO lanes VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NULL,NULL,0,0,NULL)`)
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
        )
      return this.requireLane(id)
    })
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
      const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId)
      if (row) {
        if (row.client_id !== clientId || row.op_hash !== hash || row.lane_id !== laneId)
          return { kind: 'conflict' }
        return {
          kind: 'existing',
          receipt:
            row.status === 'started'
              ? { requestId, status: 'pending' }
              : storedReceipt(JSON.parse(str(row, 'receipt_json'))),
        }
      }
      const now = this.clock()
      this.prune(now)
      check(
        Number(this.db.prepare('SELECT count(*) AS count FROM receipts').get()?.count) <
          HOST_LIMITS.receiptsKept,
      )
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
    const json = canonicalJson(value)
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
  private prune(now: number): void {
    this.db
      .prepare("DELETE FROM receipts WHERE status!='started' AND started_at<=?")
      .run(now - HOST_LIMITS.receiptTtlMs)
    this.db
      .prepare(
        `DELETE FROM receipts WHERE request_id IN (SELECT request_id FROM receipts WHERE status!='started' ORDER BY started_at DESC,request_id DESC LIMIT -1 OFFSET ?)`,
      )
      .run(
        Math.max(
          0,
          HOST_LIMITS.receiptsKept -
            Number(
              this.db.prepare("SELECT count(*) AS count FROM receipts WHERE status='started'").get()
                ?.count,
            ),
        ),
      )
  }
  pruneReceipts(now: number): void {
    integer(now)
    this.transaction(() => this.prune(now))
  }
  /** A bounded read for reconciliation, without exposing the database handle. */
  sessionLane(file: string): StoredLane | null {
    absolutePath(file)
    const row = this.db.prepare('SELECT * FROM lanes WHERE session_file=?').get(file)
    return row ? this.lane(row) : null
  }
}
