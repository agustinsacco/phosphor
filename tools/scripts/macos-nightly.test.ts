import { describe, expect, it, vi } from 'vitest'
import { decide, E2E_JOB, nightlyHistory, report } from './macos-nightly.mjs'

const HOUR = 3_600_000
const now = Date.parse('2026-11-10T15:00:00Z')
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString()
const repo = { owner: 'o', repo: 'r' }

describe('decide', () => {
  const quiet = { finished: null, running: false }
  const ranAgo = (hours: number) => ({ finished: { at: now - hours * HOUR }, running: false })

  it('a manual run always takes the Mac', () => {
    expect(decide({ event: 'workflow_dispatch', now, history: ranAgo(1), since: 0 })).toEqual({
      run: true,
      stale: false,
    })
  })

  it('a scheduled slot runs once a day: skipped after a recent run or while one runs', () => {
    expect(decide({ event: 'schedule', now, history: quiet, since: 0 }).run).toBe(true)
    expect(decide({ event: 'schedule', now, history: ranAgo(21), since: 0 }).run).toBe(true)
    expect(decide({ event: 'schedule', now, history: ranAgo(4), since: 0 }).run).toBe(false)
    expect(
      decide({ event: 'schedule', now, history: { finished: null, running: true }, since: 0 }).run,
    ).toBe(false)
  })

  it('a push never takes the Mac and flags a nightly quiet for 30 hours', () => {
    expect(decide({ event: 'push', now, history: ranAgo(10), since: 0 })).toEqual({
      run: false,
      stale: false,
    })
    expect(decide({ event: 'push', now, history: ranAgo(31), since: 0 }).stale).toBe(true)
    // Never finished: measured from when the workflow was added.
    expect(decide({ event: 'push', now, history: quiet, since: now - 12 * HOUR }).stale).toBe(false)
    expect(decide({ event: 'push', now, history: quiet, since: now - 40 * HOUR }).stale).toBe(true)
    expect(
      decide({ event: 'push', now, history: { finished: null, running: true }, since: 0 }).stale,
    ).toBe(false)
  })
})

describe('nightlyHistory', () => {
  it('finds the newest finished suite, ignoring pushes, skips, old runs and this run', async () => {
    const runs = [
      { id: 1, event: 'push', created_at: ago(1) },
      { id: 2, event: 'schedule', created_at: ago(2) },
      { id: 3, event: 'workflow_dispatch', created_at: ago(5) },
      { id: 4, event: 'schedule', created_at: ago(30) },
      { id: 5, event: 'schedule', created_at: ago(100) },
      { id: 9, event: 'schedule', created_at: ago(0) },
    ]
    const jobs: Record<number, object> = {
      2: { name: E2E_JOB, status: 'completed', conclusion: 'skipped', completed_at: ago(2) },
      3: { name: E2E_JOB, status: 'completed', conclusion: 'failure', completed_at: ago(4) },
      4: { name: E2E_JOB, status: 'completed', conclusion: 'success', completed_at: ago(29) },
    }
    const listJobsForWorkflowRun = vi.fn(async ({ run_id }: { run_id: number }) => ({
      data: { jobs: jobs[run_id] ? [{ name: 'decide' }, jobs[run_id]] : [] },
    }))
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
          listJobsForWorkflowRun,
        },
      },
    }
    const history = await nightlyHistory(github, repo, { workflowId: 7, currentRunId: 9, now })
    expect(history).toEqual({
      finished: { at: Date.parse(ago(4)), conclusion: 'failure' },
      running: false,
    })
    expect(listJobsForWorkflowRun.mock.calls.map(([call]) => call.run_id)).toEqual([2, 3, 4])
  })

  it('reports a suite still running', async () => {
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async () => ({
            data: { workflow_runs: [{ id: 2, event: 'schedule', created_at: ago(0.2) }] },
          }),
          listJobsForWorkflowRun: async () => ({
            data: { jobs: [{ name: E2E_JOB, status: 'in_progress', conclusion: null }] },
          }),
        },
      },
    }
    expect(await nightlyHistory(github, repo, { workflowId: 7, currentRunId: 9, now })).toEqual({
      finished: null,
      running: true,
    })
  })
})

describe('report', () => {
  function issues(open: { number: number }[]) {
    return {
      listForRepo: vi.fn(async () => ({ data: open })),
      create: vi.fn(async (_issue: { body: string; labels: string[] }) => ({})),
      createComment: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    }
  }
  const base = {
    decided: 'success',
    stale: false,
    lastAt: null,
    runUrl: 'URL',
    sha: 'a'.repeat(40),
  }

  it('opens an issue on a failed or cancelled run, then comments while it stays open', async () => {
    for (const e2e of ['failure', 'cancelled']) {
      const fresh = issues([])
      expect(await report({ rest: { issues: fresh } }, repo, { ...base, e2e })).toBe('opened')
      expect(fresh.create).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['macos-nightly'] }),
      )
      const open = issues([{ number: 4 }])
      expect(await report({ rest: { issues: open } }, repo, { ...base, e2e })).toBe('commented')
      expect(open.create).not.toHaveBeenCalled()
    }
  })

  it('closes the open issue once a run is green', async () => {
    const open = issues([{ number: 4 }])
    expect(await report({ rest: { issues: open } }, repo, { ...base, e2e: 'success' })).toBe(
      'closed',
    )
    expect(open.update).toHaveBeenCalledWith({ ...repo, issue_number: 4, state: 'closed' })
  })

  it('opens one stale notice per outage and stays quiet on a skipped, fresh run', async () => {
    const fresh = issues([])
    expect(
      await report({ rest: { issues: fresh } }, repo, { ...base, e2e: 'skipped', stale: true }),
    ).toBe('opened')
    expect(fresh.create.mock.calls[0]![0].body).toContain('has not finished since it was added')
    const open = issues([{ number: 4 }])
    expect(
      await report({ rest: { issues: open } }, repo, { ...base, e2e: 'skipped', stale: true }),
    ).toBe('already open')
    expect(open.createComment).not.toHaveBeenCalled()
    expect(await report({ rest: { issues: issues([]) } }, repo, { ...base, e2e: 'skipped' })).toBe(
      'nothing to report',
    )
  })

  it('reports a decide job that failed', async () => {
    const fresh = issues([])
    await report({ rest: { issues: fresh } }, repo, { ...base, decided: 'failure', e2e: 'skipped' })
    expect(fresh.create.mock.calls[0]![0].body).toContain('could not decide')
  })
})
