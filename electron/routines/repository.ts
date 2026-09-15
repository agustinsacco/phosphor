import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  activeRun,
  latestOccurrence,
  nextOccurrences,
  type Routine,
  type RoutineInput,
  type RoutineRun,
  type RoutineRunStatus,
} from '@shared/routines'

/** Single main-process writer. Each occurrence and cursor advance commits together. */
export class RoutineRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version
    if (version !== 0 && version !== 1)
      throw new Error('Routines database is newer than this app. Upgrade Phosphor.')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, occurrence TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_history ON runs(routine_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `)
  }

  close(): void {
    this.db.close()
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

  routines(): Routine[] {
    return this.db
      .prepare('SELECT data FROM routines')
      .all()
      .map((row) => JSON.parse(row.data as string) as Routine)
  }

  get(id: string): Routine {
    const row = this.db.prepare('SELECT data FROM routines WHERE id=?').get(id)
    if (!row) throw new Error('Routine not found.')
    return JSON.parse(row.data as string) as Routine
  }

  private put(routine: Routine): void {
    this.db
      .prepare('INSERT OR REPLACE INTO routines VALUES (?, ?)')
      .run(routine.id, JSON.stringify(routine))
  }

  history(routineId?: string, offset = 0, limit = 100): RoutineRun[] {
    const rows = routineId
      ? this.db
          .prepare(
            'SELECT data FROM runs WHERE routine_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
          )
          .all(routineId, limit, offset)
      : this.db
          .prepare('SELECT data FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
          .all(limit, offset)
    return rows.map((r) => JSON.parse(r.data as string) as RoutineRun)
  }

  run(id: string): RoutineRun {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id)
    if (!row) throw new Error('Run not found.')
    return JSON.parse(row.data as string) as RoutineRun
  }

  pending(): RoutineRun[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data, '$.status') IN ('queued','running') ORDER BY created_at, rowid",
      )
      .all()
      .map((r) => JSON.parse(r.data as string) as RoutineRun)
  }

  save(input: RoutineInput, now: number, id?: string, revision?: number): Routine {
    return this.transaction(() => {
      const old = id ? this.get(id) : undefined
      if (old && old.revision !== revision)
        throw new Error('This routine changed. Reopen the editor before saving.')
      if (!old && this.routines().filter((r) => !r.archived).length >= 100)
        throw new Error('Archive a routine before adding more (limit 100).')
      if (old?.archived) throw new Error('Duplicate an archived routine to use it again.')
      const nextAt = input.enabled
        ? (nextOccurrences(input.schedule, input.timezone, now, 1)[0] ?? null)
        : null
      if (input.enabled && input.schedule.kind !== 'manual' && nextAt === null)
        throw new Error(
          'The schedule has no future occurrence. Choose a future date or save paused.',
        )
      const routine: Routine = {
        ...input,
        id: old?.id ?? randomUUID(),
        revision: (old?.revision ?? 0) + 1,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        nextAt,
        attention: null,
        archived: false,
      }
      this.put(routine)
      // Edits only affect future execution, never a running snapshot. Stale queued
      // snapshots must not execute after an authority/workspace change or pause.
      for (const run of this.pending().filter(
        (r) => r.routineId === routine.id && r.status === 'queued',
      )) {
        this.patchRun(run.id, {
          status: 'skipped',
          reason: 'Routine edited or paused before execution.',
          endedAt: now,
        })
      }
      return routine
    })
  }

  archive(id: string, now: number): void {
    this.transaction(() => {
      if (this.pending().some((r) => r.routineId === id && r.status === 'running'))
        throw new Error('Cancel the active run before archiving.')
      const routine = this.get(id)
      this.put({
        ...routine,
        archived: true,
        enabled: false,
        nextAt: null,
        updatedAt: now,
        revision: routine.revision + 1,
      })
      for (const run of this.pending().filter((r) => r.routineId === id))
        this.patchRun(run.id, { status: 'skipped', endedAt: now, reason: 'Routine archived.' })
    })
  }

  private insert(
    routine: Routine,
    at: number,
    now: number,
    trigger: RoutineRun['trigger'],
    key: string,
    status: RoutineRunStatus = 'queued',
    reason = '',
  ): RoutineRun {
    const occurrence = `${routine.id}:${trigger}:${key}`
    const existing = this.db.prepare('SELECT data FROM runs WHERE occurrence=?').get(occurrence)
    if (existing) return JSON.parse(existing.data as string) as RoutineRun
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      trigger,
      scheduledAt: at,
      createdAt: now,
      startedAt: null,
      endedAt: status === 'queued' ? null : now,
      status,
      reason,
      definition: routine,
      sessionId: null,
      sessionPath: null,
      workspacePath: null,
      branch: null,
      baseCommit: null,
      accountId: null,
      summary: '',
    }
    this.db
      .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)')
      .run(run.id, routine.id, occurrence, now, JSON.stringify(run))
    return run
  }

  manual(id: string, requestId: string, now: number): RoutineRun {
    return this.transaction(() => {
      const routine = this.get(id)
      if (routine.archived || !routine.trusted)
        throw new Error('Review and acknowledge unattended access first.')
      if (routine.attention)
        throw new Error('Resolve the attention item and save the routine before running again.')
      // Run now is deliberately not a way to overlap a routine or move its clock.
      const active = this.pending().find((r) => r.routineId === id)
      return active ?? this.insert(routine, now, now, 'manual', requestId)
    })
  }

  skipNext(id: string, now: number): void {
    this.transaction(() => {
      const r = this.get(id)
      if (r.nextAt === null) throw new Error('No scheduled occurrence to skip.')
      this.insert(r, r.nextAt, now, 'schedule', String(r.nextAt), 'skipped', 'Skipped by you.')
      this.put({ ...r, nextAt: nextOccurrences(r.schedule, r.timezone, r.nextAt, 1)[0] ?? null })
    })
  }

  reconcile(now: number): void {
    this.transaction(() => {
      for (const r of this.routines()) {
        if (!r.enabled || r.archived || r.nextAt === null || r.nextAt > now) continue
        const latest = latestOccurrence(r, now)
        if (latest > r.nextAt)
          this.insert(
            r,
            r.nextAt,
            now,
            'schedule',
            String(r.nextAt),
            'skipped',
            `Missed occurrences before ${new Date(latest).toISOString()} were coalesced; only the latest is eligible.`,
          )
        for (const queued of this.pending().filter(
          (q) => q.routineId === r.id && q.status === 'queued' && q.trigger === 'schedule',
        )) {
          this.patchRun(queued.id, {
            status: 'skipped',
            reason: 'Superseded by a newer scheduled occurrence.',
            endedAt: now,
          })
        }
        const expired = now - latest > Math.max(60000, r.catchUpHours * 3600000)
        this.insert(
          r,
          latest,
          now,
          'schedule',
          String(latest),
          expired ? 'skipped' : 'queued',
          expired ? 'App unavailable beyond the catch-up window.' : '',
        )
        this.put({ ...r, nextAt: nextOccurrences(r.schedule, r.timezone, now, 1)[0] ?? null })
      }
    })
  }

  claim(id: string, now: number): RoutineRun | null {
    return this.transaction(() => {
      const run = this.run(id)
      if (
        run.status !== 'queued' ||
        this.pending().some((r) => r.routineId === run.routineId && r.status === 'running')
      )
        return null
      if (now - run.scheduledAt > Math.max(60000, run.definition.catchUpHours * 3600000)) {
        this.patchRun(id, { status: 'skipped', reason: 'Queue deadline exceeded.', endedAt: now })
        return null
      }
      return this.patchRun(id, { status: 'running', startedAt: now })
    })
  }

  patchRun(
    id: string,
    patch: Partial<Omit<RoutineRun, 'id' | 'routineId' | 'definition'>>,
  ): RoutineRun {
    const run = { ...this.run(id), ...patch }
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), id)
    return run
  }

  finish(id: string, status: RoutineRunStatus, reason: string, now: number): void {
    this.transaction(() => {
      const run = this.run(id)
      if (!activeRun(run)) return
      this.patchRun(id, { status, reason, endedAt: now })
      const routine = this.get(run.routineId)
      const recent = this.history(routine.id)
        .filter((r) => !activeRun(r) && r.status !== 'skipped')
        .slice(0, 3)
      const repeated =
        recent.length === 3 &&
        recent.every((r) => ['failed', 'blocked', 'timed-out', 'interrupted'].includes(r.status))
      if (status === 'blocked' || status === 'interrupted' || repeated) {
        this.put({
          ...routine,
          enabled: false,
          nextAt: null,
          attention: reason,
          revision: routine.revision + 1,
        })
        for (const queued of this.pending().filter(
          (r) => r.routineId === routine.id && r.status === 'queued',
        )) {
          this.patchRun(queued.id, {
            status: 'skipped',
            reason: 'Routine paused: needs attention.',
            endedAt: now,
          })
        }
      }
    })
  }

  recover(now: number): void {
    for (const run of this.pending().filter((r) => r.status === 'running')) {
      this.finish(
        run.id,
        'interrupted',
        'Phosphor stopped during execution; external actions may have completed. Verify the previous worker has stopped and inspect its output before saving to resume. No automatic replay.',
        now,
      )
    }
  }

  background(): boolean {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key='background'").get()?.value === 'true'
    )
  }
  setBackground(enabled: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('background', ?)").run(String(enabled))
  }
}
