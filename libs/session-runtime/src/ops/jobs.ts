/**
 * Background ops (reconcile-v2 #7): an op that can outlast its answer deadline
 * answers `Started …` with a `jobId` at once and runs here. Its state and
 * final result live in the owner's `agent_jobs` table, so `job.status` and
 * `job.list` read them; only the principal that started a job sees it. A job
 * still running when the owner stopped reads `interrupted` on the next open.
 * Living contract: docs/agent-control.md.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeLog } from '../file-log'
import { OpRefusal } from './builtins'
import type { OpsJobPort } from './ports'
import { principalKey } from './principals'
import { dataResult, op } from './results'

export type AgentJobState = 'running' | 'done' | 'failed' | 'interrupted'

export interface AgentJob {
  readonly jobId: string
  readonly op: string
  readonly state: AgentJobState
  /** The handler's answer when done, or why it failed. */
  readonly result: { readonly text: string; readonly data?: unknown } | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface JobStorePorts {
  readonly now: () => number
  readonly newId: () => string
  readonly log: RuntimeLog
}

/** Finished jobs older than this are pruned when a job starts. */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STATES = new Set<string>(['running', 'done', 'failed', 'interrupted'])
const LIST_LIMIT = 50

function jobFrom(row: Record<string, unknown> | undefined): AgentJob | null {
  if (!row || typeof row.id !== 'string' || typeof row.op !== 'string') return null
  if (typeof row.state !== 'string' || !STATES.has(row.state)) return null
  let result: AgentJob['result'] = null
  try {
    const parsed: unknown = typeof row.result === 'string' ? JSON.parse(row.result) : null
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { text?: unknown }).text === 'string'
    )
      result = parsed as AgentJob['result']
  } catch {
    result = null
  }
  return {
    jobId: row.id,
    op: row.op,
    state: row.state as AgentJobState,
    result,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** The jobs port over `agent_jobs` (DDL in the owner's store), with the reads `job.*` serve. */
export function createJobStore(db: DatabaseSync, ports: JobStorePorts) {
  const controllers = new Set<AbortController>()
  db.prepare(`UPDATE agent_jobs SET state='interrupted', updated_at=? WHERE state='running'`).run(
    ports.now(),
  )
  function finish(jobId: string, state: AgentJobState, result: AgentJob['result']) {
    db.prepare('UPDATE agent_jobs SET state=?, result=?, updated_at=? WHERE id=?').run(
      state,
      JSON.stringify(result),
      ports.now(),
      jobId,
    )
  }
  const port: OpsJobPort = {
    async start({ creator, op: name, run }) {
      const jobId = ports.newId()
      const at = ports.now()
      db.prepare(`DELETE FROM agent_jobs WHERE state != 'running' AND updated_at < ?`).run(
        at - JOB_RETENTION_MS,
      )
      db.prepare(
        `INSERT INTO agent_jobs (id, principal, op, state, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)`,
      ).run(jobId, creator, name, at, at)
      const controller = new AbortController()
      controllers.add(controller)
      run(controller.signal)
        .then(
          (out) =>
            finish(jobId, 'done', {
              text: out.text,
              ...(out.data !== undefined ? { data: out.data } : {}),
            }),
          (error: unknown) =>
            finish(jobId, 'failed', {
              text: error instanceof Error ? error.message : String(error),
            }),
        )
        .catch((error: unknown) => ports.log('ops', 'job record failed', { error: String(error) }))
        .finally(() => controllers.delete(controller))
      return { jobId }
    },
  }
  return {
    port,
    /** Null unless `creator` (a principal key) started it. */
    get(jobId: string, creator: string): AgentJob | null {
      return jobFrom(
        db.prepare('SELECT * FROM agent_jobs WHERE id=? AND principal=?').get(jobId, creator),
      )
    },
    list(creator: string): AgentJob[] {
      return db
        .prepare('SELECT * FROM agent_jobs WHERE principal=? ORDER BY created_at DESC, id LIMIT ?')
        .all(creator, LIST_LIMIT)
        .flatMap((row) => jobFrom(row) ?? [])
    },
    /** Owner shutdown: running jobs are aborted and read `interrupted` on the next open. */
    close() {
      for (const controller of controllers) controller.abort()
    },
  }
}

export type JobStore = ReturnType<typeof createJobStore>

/** `job.status` and `job.list`, each limited to the asking principal's own jobs. */
export function jobHandlers(jobs: Pick<JobStore, 'get' | 'list'>) {
  return {
    'job.status': op<{ jobId: string }>(({ jobId }, ctx) => {
      const job = jobs.get(jobId, principalKey(ctx.principal))
      if (!job) throw new OpRefusal('forbidden', `No job ${jobId} that you started.`)
      const done = job.state === 'done' && job.result ? `\n${job.result.text}` : ''
      return { ...dataResult(job), text: `Job ${jobId}: ${job.state}.${done}` }
    }),
    'job.list': op((_args, ctx) => dataResult(jobs.list(principalKey(ctx.principal)))),
  }
}
