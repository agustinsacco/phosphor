import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadSqlite } from '../sqlite'
import { createJobStore, jobHandlers, JOB_RETENTION_MS } from './jobs'
import type { OpHandlerContext } from './types'

/** K2's `agent_jobs` shape (apps/host/src/lanes/store/additive.ts). */
const AGENT_JOBS = `CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY NOT NULL, principal TEXT NOT NULL, op TEXT NOT NULL, state TEXT NOT NULL,
  progress TEXT, result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;`

let db: DatabaseSync
let clock = 1000
let ids = 0
const ports = { now: () => clock, newId: () => `job-${++ids}`, log: () => {} }
const ctx = (clientId: string) =>
  ({ principal: { kind: 'local', clientId } }) as unknown as OpHandlerContext

beforeEach(() => {
  db = new (loadSqlite().DatabaseSync)(':memory:')
  db.exec(AGENT_JOBS)
  clock = 1000
  ids = 0
})
afterEach(() => db.close())

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

it('answers a job id at once and records its result for the creator only', async () => {
  const jobs = createJobStore(db, ports)
  const work = deferred<{ text: string; data?: unknown }>()
  const { jobId } = await jobs.port.start({
    creator: 'local:a',
    op: 'package.update',
    run: () => work.promise,
  })
  expect(jobs.get(jobId, 'local:a')).toMatchObject({ state: 'running', result: null })
  expect(jobs.get(jobId, 'local:b')).toBeNull()
  work.resolve({ text: 'Updated 2 packages.', data: { count: 2 } })
  await new Promise((r) => setTimeout(r, 0))
  expect(jobs.get(jobId, 'local:a')).toMatchObject({
    state: 'done',
    result: { text: 'Updated 2 packages.', data: { count: 2 } },
  })
  const handlers = jobHandlers(jobs)
  expect((await handlers['job.status']!({ jobId }, ctx('a'))).text).toBe(
    `Job ${jobId}: done.\nUpdated 2 packages.`,
  )
  await expect(handlers['job.status']!({ jobId }, ctx('b'))).rejects.toMatchObject({
    code: 'forbidden',
  })
  expect((await handlers['job.list']!({}, ctx('b'))).data).toEqual([])
})

it('records a failure, and marks a job running at shutdown interrupted on the next open', async () => {
  const jobs = createJobStore(db, ports)
  const failing = await jobs.port.start({
    creator: 'local:a',
    op: 'package.install',
    run: async () => {
      throw new Error('npm exited 1')
    },
  })
  const hanging = await jobs.port.start({
    creator: 'local:a',
    op: 'service.update',
    run: () => new Promise(() => {}),
  })
  await new Promise((r) => setTimeout(r, 0))
  expect(jobs.get(failing.jobId, 'local:a')).toMatchObject({
    state: 'failed',
    result: { text: 'npm exited 1' },
  })
  jobs.close()
  const reopened = createJobStore(db, ports)
  expect(reopened.get(hanging.jobId, 'local:a')?.state).toBe('interrupted')
  expect(reopened.list('local:a').map((job) => job.jobId)).toEqual(
    [failing.jobId, hanging.jobId].sort(),
  )
})

it('aborts running jobs on close and prunes finished jobs past retention', async () => {
  const jobs = createJobStore(db, ports)
  let aborted = false
  await jobs.port.start({
    creator: 'local:a',
    op: 'service.update',
    run: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('stopped'))
        })
      }),
  })
  const old = await jobs.port.start({
    creator: 'local:a',
    op: 'package.list',
    run: async () => ({ text: 'ok' }),
  })
  await new Promise((r) => setTimeout(r, 0))
  jobs.close()
  expect(aborted).toBe(true)
  clock += JOB_RETENTION_MS + 1
  await jobs.port.start({
    creator: 'local:a',
    op: 'package.list',
    run: async () => ({ text: 'ok' }),
  })
  expect(jobs.get(old.jobId, 'local:a')).toBeNull()
})
