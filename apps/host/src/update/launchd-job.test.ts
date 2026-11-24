import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServiceRunner } from '../machine/systemd'
import {
  UPDATE_JOB_LABEL,
  retireUpdateJob,
  retireUpdateJobAtStart,
  servicePid,
  startUpdateJob,
  updateJob,
  updateJobPlist,
} from './launchd-job'

/** Tests only: a spike label, so nothing here can name the real updater job. */
const LABEL = 'com.saccolabs.phosphor-spike.d4-job'
const uid = process.getuid?.()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function state() {
  const root = mkdtempSync(join(tmpdir(), 'host-update-job-'))
  roots.push(root)
  return join(root, 'state')
}
function runner(answers: Record<string, { code: number | null; stdout?: string }> = {}) {
  const calls: string[][] = []
  const run: ServiceRunner = async (_program, args) => {
    calls.push([...args])
    const answer = answers[args[0]!] ?? { code: 0 }
    return { code: answer.code, stdout: answer.stdout ?? '' }
  }
  return { run, calls }
}

describe('the one-shot update job', () => {
  it('lives under the state folder and is labelled for the updater by default', () => {
    expect(updateJob('/s')).toEqual({
      label: UPDATE_JOB_LABEL,
      plist: `/s/update/${UPDATE_JOB_LABEL}.plist`,
      log: '/s/update/update.log',
    })
  })

  it('writes a private plist in a private folder, boots out a stale job, then bootstraps', async () => {
    const job = updateJob(state(), LABEL)
    const { run, calls } = runner({ bootout: { code: 3 } })
    expect(await startUpdateJob(run, uid, job, ['/v/node', '/v/phosphor.mjs', 'update'], {})).toBe(
      true,
    )
    expect(calls).toEqual([
      ['bootout', `gui/${uid}/${LABEL}`],
      ['bootstrap', `gui/${uid}`, job.plist],
    ])
    expect(lstatSync(job.plist).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(job.plist, '..')).mode & 0o777).toBe(0o700)
  })

  it('reports a bootstrap launchd refused', async () => {
    const { run } = runner({ bootstrap: { code: 5 } })
    expect(await startUpdateJob(run, uid, updateJob(state(), LABEL), ['/n'], {})).toBe(false)
  })

  it('escapes values and refuses a relative program', () => {
    const job = updateJob('/s', LABEL)
    const text = updateJobPlist(job, ['/a&b'], { V: '<x>' })
    expect(text).toContain('<key>ProgramArguments</key><array><string>/a&amp;b</string></array>')
    expect(text).toContain(
      '<key>EnvironmentVariables</key><dict><key>V</key><string>&lt;x&gt;</string></dict>',
    )
    expect(() => updateJobPlist(job, ['node'], {})).toThrow()
  })

  it("reads the service's pid only while launchd runs it", async () => {
    expect(
      await servicePid(
        runner({ print: { code: 0, stdout: 'state = running\npid = 77\n' } }).run,
        uid,
      ),
    ).toBe(77)
    expect(
      await servicePid(runner({ print: { code: 0, stdout: 'state = exited\n' } }).run, uid),
    ).toBeNull()
    expect(await servicePid(runner({ print: { code: 113 } }).run, uid)).toBeNull()
  })
})

describe('retiring the job at the next daemon start', () => {
  it('asks launchd nothing when no plist was written', async () => {
    const { run, calls } = runner()
    await retireUpdateJob(run, uid, updateJob(state(), LABEL))
    expect(calls).toEqual([])
  })

  it('leaves a job that still runs: it is the updater checking this daemon', async () => {
    const job = updateJob(state(), LABEL)
    await startUpdateJob(runner().run, uid, job, ['/n'], {})
    const { run, calls } = runner({ print: { code: 0, stdout: 'state = running\n' } })
    await retireUpdateJob(run, uid, job)
    expect(calls).toEqual([['print', `gui/${uid}/${LABEL}`]])
    expect(existsSync(job.plist)).toBe(true)
  })

  it('boots out a finished job and removes its plist', async () => {
    const job = updateJob(state(), LABEL)
    await startUpdateJob(runner().run, uid, job, ['/n'], {})
    const { run, calls } = runner({ print: { code: 0, stdout: 'state = not running\n' } })
    await retireUpdateJob(run, uid, job)
    expect(calls).toEqual([
      ['print', `gui/${uid}/${LABEL}`],
      ['bootout', `gui/${uid}/${LABEL}`],
    ])
    expect(existsSync(job.plist)).toBe(false)
  })

  it('logs a failure at start instead of failing the daemon', async () => {
    const directory = state()
    const job = updateJob(directory, LABEL)
    await startUpdateJob(runner().run, uid, job, ['/n'], {})
    const log = vi.fn()
    retireUpdateJobAtStart(
      directory,
      uid,
      async () => Promise.reject(new Error('no launchctl')),
      log,
      LABEL,
    )
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('update_job.retire_failed', {
        error: 'Error: no launchctl',
      }),
    )
  })
})
