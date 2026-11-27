import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadSqlite } from '../sqlite'
import { createJobStore, jobHandlers, JOB_RETENTION_MS } from './jobs'
import type { OpRunContext } from './ports'
import type { OpPrincipal } from './types'

/** K2's `agent_jobs` shape (apps/host/src/lanes/store/additive.ts). */
const AGENT_JOBS = `CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY NOT NULL, principal TEXT NOT NULL, op TEXT NOT NULL, state TEXT NOT NULL,
  progress TEXT, result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;`

let db: DatabaseSync
let clock = 1000
let ids = 0
const ports = { now: () => clock, newId: () => `job-${++ids}`, log: () => {} }
const context = (principal: OpPrincipal, page?: string): OpRunContext => ({
  principal,
  page,
  signal: new AbortController().signal,
  log: () => {},
})
const ctx = (clientId: string) => context({ kind: 'local', clientId })

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

it('pages summaries past 50 jobs but keeps full legacy surface rows and job.status results', async () => {
  const result = { text: `Done\n${'x'.repeat(100)}`, data: { count: 42 } }
  const insert = db.prepare('INSERT INTO agent_jobs VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
  for (const principal of ['local:a', 'surface:a', 'agent:lane-a'])
    for (let i = 1; i <= 63; i++)
      insert.run(
        `job-${principal}-${i}`,
        principal,
        'package.update',
        'done',
        JSON.stringify(result),
        i,
        i + 100,
      )
  const jobs = jobHandlers(createJobStore(db, ports))
  const surface = context({ kind: 'surface', clientId: 'a', label: 'Fixture', via: 'owner' })
  const legacy = await jobs['job.list']!({}, surface)
  expect(legacy.data).toHaveLength(50)
  expect(legacy.next).toBeUndefined()
  expect((legacy.data as unknown[])[0]).toMatchObject({ result })
  for (const principal of [
    { kind: 'local', clientId: 'a' },
    { kind: 'agent', laneRef: 'lane-a', sessionId: 's', unattended: false, lineage: 0 },
  ] satisfies OpPrincipal[]) {
    const seen: string[] = []
    let page: string | undefined
    for (const next of ['20', '40', '60', undefined]) {
      const answer = await jobs['job.list']!({}, context(principal, page))
      expect(answer.next).toBe(next)
      expect(answer.text).toMatch(/^jobId \| op \| state \| started \| finished \| result\n/)
      const rows = answer.data as { jobId: string }[]
      expect(rows[0]).toMatchObject({
        state: 'done',
        resultPreview: `Done ${'x'.repeat(74)}…`,
      })
      expect(rows[0]).not.toHaveProperty('result')
      seen.push(...rows.map(({ jobId }) => jobId))
      page = next
    }
    expect(seen).toHaveLength(63)
    expect(new Set(seen).size).toBe(63)
    const status = await jobs['job.status']!({ jobId: seen[0] }, context(principal))
    expect(status.data).toMatchObject({ result })
  }
})

it('returns the next package update cursor through job.status', async () => {
  const jobs = createJobStore(db, ports)
  const { jobId } = await jobs.port.start({
    creator: 'local:a',
    op: 'package.checkUpdates',
    run: async () => ({ text: 'First page', next: 'next-page' }),
  })
  await new Promise((r) => setTimeout(r, 0))
  const status = await jobHandlers(jobs)['job.status']!({ jobId }, ctx('a'))
  expect(status).not.toHaveProperty('next')
  expect(status.data).toMatchObject({
    op: 'package.checkUpdates',
    result: { next: 'next-page' },
  })
  expect(status.text).toContain('More: phosphor package check-updates --page next-page')
})
