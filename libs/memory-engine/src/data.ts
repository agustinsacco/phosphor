import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import type {
  BrainClaim,
  BrainDelivery,
  BrainEntity,
  BrainEvidence,
  BrainJob,
  BrainPrefs,
  BrainProposal,
  BrainRevision,
} from '@phosphor/shared/brain'
import type { MemoryStoreOptions } from './ports'

export interface Documents {
  evidence: Omit<BrainEvidence, 'text'>
  entities: BrainEntity
  claims: BrainClaim
  jobs: BrainJob
  proposals: BrainProposal
  deliveries: BrainDelivery
  receipts: { id: string; value: string; result: string | null }
  purges: { jobId: string; sessionPath: string }
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
export function identifier(...values: unknown[]): string {
  return createHash('sha256').update(stable(values)).digest('hex')
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error('Unsafe memory directory')
  chmodSync(path, 0o700)
}
export class Data {
  readonly db: InstanceType<MemoryStoreOptions['Database']>
  readonly blobs: string
  readonly now: () => number
  private closed = false
  constructor(options: MemoryStoreOptions) {
    privateDirectory(options.directory)
    this.blobs = join(options.directory, 'evidence')
    privateDirectory(this.blobs)
    const filename = join(options.directory, 'memory.sqlite')
    if (!existsSync(filename)) closeSync(openSync(filename, 'wx', 0o600))
    if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
      throw new Error('Unsafe memory database')
    chmodSync(filename, 0o600)
    this.db = new options.Database(filename)
    this.now = options.now ?? Date.now
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS document_scope ON documents(kind,scope);
      CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS job_batches (id TEXT PRIMARY KEY,attempt INTEGER NOT NULL,job_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retained (id TEXT PRIMARY KEY, retained_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_sources (source_id TEXT NOT NULL,derived_id TEXT NOT NULL,PRIMARY KEY(source_id,derived_id));
      CREATE TABLE IF NOT EXISTS entity_sources (seq INTEGER PRIMARY KEY,entity_id TEXT NOT NULL,
        source_id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,recorded_at INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entity_source_scope ON entity_sources(scope,recorded_at,entity_id);
      CREATE TABLE IF NOT EXISTS claim_sources (claim_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(claim_id,evidence_id));
      CREATE TABLE IF NOT EXISTS claim_versions (seq INTEGER PRIMARY KEY,claim_id TEXT NOT NULL,
        scope TEXT NOT NULL,recorded_at INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS claim_history ON claim_versions(claim_id,recorded_at,seq);
      CREATE INDEX IF NOT EXISTS retained_time ON retained(retained_at);
      CREATE TABLE IF NOT EXISTS vectors (claim_id TEXT NOT NULL, model_id TEXT NOT NULL,
        revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(claim_id,model_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(id UNINDEXED, text);
      INSERT INTO claim_fts(claim_fts,rank) VALUES('secure-delete',1);`)
    this.db
      .prepare('INSERT OR IGNORE INTO meta VALUES (?,?)')
      .run('prefs', JSON.stringify(DEFAULT_BRAIN_PREFS))
    this.db
      .prepare('INSERT OR IGNORE INTO meta VALUES (?,?)')
      .run('revision', JSON.stringify({ graphRevision: 0, policyEpoch: 0 }))
    this.db
      .prepare(`INSERT OR IGNORE INTO retained SELECT id,? FROM documents WHERE kind='evidence'`)
      .run(this.now())
    this.transaction(() => {
      for (const job of this.all('jobs')) {
        if (job.state === 'running')
          this.put('jobs', job.id, job.scope, {
            ...job,
            state: 'interrupted',
            fence: job.fence + 1,
            updatedAt: this.now(),
            error: 'Process restarted',
          })
      }
    })
  }
  transaction<T>(fn: () => T): T {
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
  meta<T>(key: string): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
    if (!row) throw new Error('Missing memory metadata')
    return JSON.parse(String(row.value)) as T
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value))
  }
  prefs(): BrainPrefs {
    return this.meta('prefs')
  }
  revision(): BrainRevision {
    return this.meta('revision')
  }
  bump(): void {
    const revision = this.revision()
    this.setMeta('revision', { ...revision, graphRevision: revision.graphRevision + 1 })
  }
  assertRevision(revision: BrainRevision): void {
    const current = this.revision()
    if (
      current.policyEpoch !== revision.policyEpoch ||
      current.graphRevision !== revision.graphRevision
    ) {
      throw new Error('Stale memory revision or consent')
    }
  }
  enrolled(scope: string): boolean {
    const prefs = this.prefs()
    return prefs.enabled && prefs.workspaces.includes(scope)
  }
  consent(scope: string): void {
    if (!this.enrolled(scope)) throw new Error('Memory consent unavailable for scope')
  }
  get<K extends keyof Documents>(kind: K, id: string): Documents[K] | undefined {
    const row = this.db.prepare('SELECT value FROM documents WHERE kind=? AND id=?').get(kind, id)
    return row ? (JSON.parse(String(row.value)) as Documents[K]) : undefined
  }
  require<K extends keyof Documents>(kind: K, id: string): Documents[K] {
    const value = this.get(kind, id)
    if (!value) throw new Error(`Unknown ${kind} reference`)
    return value
  }
  all<K extends keyof Documents>(
    kind: K,
    scopes?: string[],
    limit = Number.MAX_SAFE_INTEGER,
  ): Documents[K][] {
    if (scopes?.length === 0) return []
    const params: SQLInputValue[] = [kind]
    const scopeSql = scopes ? ` AND scope IN (${scopes.map(() => '?').join(',')})` : ''
    if (scopes) params.push(...scopes)
    params.push(limit)
    return this.db
      .prepare(`SELECT value FROM documents WHERE kind=?${scopeSql} ORDER BY id LIMIT ?`)
      .all(...params)
      .map((row) => JSON.parse(String(row.value)) as Documents[K])
  }
  activity<K extends 'jobs' | 'proposals'>(
    kind: K,
    scopes: string[],
    limit: number,
  ): Documents[K][] {
    if (!scopes.length) return []
    const order =
      kind === 'proposals'
        ? `CASE json_extract(value,'$.state') WHEN 'pending' THEN 0 ELSE 1 END,
          json_extract(value,'$.createdAt') DESC,id`
        : `CASE json_extract(value,'$.state') WHEN 'running' THEN 0 WHEN 'queued' THEN 1
          WHEN 'interrupted' THEN 2 WHEN 'proposed' THEN 3 ELSE 4 END,
          json_extract(value,'$.updatedAt') DESC,json_extract(value,'$.createdAt') DESC,id`
    return this.db
      .prepare(
        `SELECT value FROM documents WHERE kind=? AND scope IN
      (${scopes.map(() => '?').join(',')}) ORDER BY ${order} LIMIT ?`,
      )
      .all(kind, ...scopes, limit)
      .map((row) => JSON.parse(String(row.value)) as Documents[K])
  }
  count(kind: keyof Documents): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM documents WHERE kind=?').get(kind)?.n)
  }
  put<K extends keyof Documents>(kind: K, id: string, scope: string, value: Documents[K]): void {
    this.db
      .prepare('INSERT OR REPLACE INTO documents VALUES (?,?,?,?)')
      .run(kind, id, scope, JSON.stringify(value))
  }
  remove(kind: keyof Documents, id: string): void {
    this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id)
  }
  tombstoned(id: string): boolean {
    return !!this.db.prepare('SELECT id FROM tombstones WHERE id=?').get(id)
  }
  tombstone(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(id)
  }
  saveClaim(claim: BrainClaim): void {
    this.put('claims', claim.id, claim.scope, claim)
    this.db
      .prepare('INSERT INTO claim_versions(claim_id,scope,recorded_at,value) VALUES (?,?,?,?)')
      .run(claim.id, claim.scope, this.now(), JSON.stringify(claim))
    this.db.prepare('DELETE FROM claim_fts WHERE id=?').run(claim.id)
    this.db.prepare('INSERT INTO claim_fts(id,text) VALUES (?,?)').run(claim.id, claim.summary)
    this.db.prepare('DELETE FROM vectors WHERE claim_id=?').run(claim.id)
  }
  close(): void {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }
}
