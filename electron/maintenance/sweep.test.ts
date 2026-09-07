import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import { addWorktree, commitAll } from '../fs/git-worktrees'
import { directorySize, sweep } from './sweep'

/**
 * Real git, real directories, real `du` — the same choice
 * `git-worktrees.test.ts` makes. `policy.test.ts` already covers the judgment
 * exhaustively against fabricated facts; what is untested without a real repo
 * is whether a sweep DELETES what the policy cleared and only that.
 */

const execFileAsync = promisify(execFile)
const HOUR = 60 * 60 * 1000

let repo: string

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

/** A lane whose branch has landed on the trunk as a squash, as pidex lanes do. */
async function mergedLane(name: string): Promise<string> {
  const branch = `pidex/${name}`
  const { path } = await addWorktree(repo, name, { kind: 'new', base: 'main', branch })
  await writeFile(join(path, `${name}.txt`), 'work\n')
  await commitAll(path, `work on ${name}`)
  await git(repo, ['merge', '--squash', branch])
  await git(repo, ['commit', '-m', `squashed ${name}`])
  return path
}

const prefs = { ...DEFAULT_MAINTENANCE_PREFS, reclaimMergedWorktrees: true }

/** Past every lane's grace period, so age never masks what is being asserted. */
const later = (): number => Date.now() + 48 * HOUR

beforeEach(async () => {
  repo = realpathSync.native(await mkdtemp(join(tmpdir(), 'pidex-sweep-')))
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@pidex.dev'])
  await git(repo, ['config', 'user.name', 'pidex test'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'initial'])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('sweep', () => {
  it('measures without deleting when act is false', async () => {
    const lane = await mergedLane('landed')

    const report = await sweep({
      repoPath: repo,
      prefs,
      protectedPaths: [],
      liveSessionCount: 0,
      act: false,
      now: later(),
    })

    expect(report.candidates.map((c) => c.path)).toEqual([lane])
    expect(report.reclaimableBytes).toBeGreaterThan(0)
    expect(report.reclaimed).toEqual([])
    expect(report.reclaimedBytes).toBe(0)
    expect(existsSync(lane)).toBe(true)
    expect(report.errors).toEqual([])
  })

  it('deletes the lane and its branch when act is true', async () => {
    const lane = await mergedLane('landed')

    const report = await sweep({
      repoPath: repo,
      prefs,
      protectedPaths: [],
      liveSessionCount: 2,
      act: true,
      now: later(),
    })

    expect(report.reclaimed.map((r) => r.path)).toEqual([lane])
    expect(report.reclaimedBytes).toBeGreaterThan(0)
    expect(existsSync(lane)).toBe(false)
    expect(await git(repo, ['branch', '--list', 'pidex/landed'])).toBe('')
    expect(report.liveSessionCount).toBe(2)
    expect(report.errors).toEqual([])
  })

  it('holds a dirty lane, an in-use lane and the main checkout', async () => {
    const dirty = await mergedLane('dirty-lane')
    await writeFile(join(dirty, 'scratch.txt'), 'unsaved\n')
    const inUse = await mergedLane('open-lane')

    const report = await sweep({
      repoPath: repo,
      prefs,
      protectedPaths: [inUse],
      liveSessionCount: 1,
      act: true,
      now: later(),
    })

    expect(report.reclaimed).toEqual([])
    expect(existsSync(dirty)).toBe(true)
    expect(existsSync(inUse)).toBe(true)
    const reasons = new Map(report.held.map((h) => [h.path, h.reason]))
    expect(reasons.get(repo)).toBe('main-checkout')
    expect(reasons.get(dirty)).toBe('dirty')
    expect(reasons.get(inUse)).toBe('in-use')
  })

  it('prunes a registration whose directory was deleted by hand', async () => {
    const lane = await mergedLane('gone')
    await rm(lane, { recursive: true, force: true })

    const report = await sweep({
      repoPath: repo,
      prefs,
      protectedPaths: [],
      liveSessionCount: 0,
      act: true,
      now: later(),
    })

    expect(report.prunedRegistrations.join('\n')).toContain('gone')
    expect(report.worktreeCount).toBe(1)
    expect(report.errors).toEqual([])
  })
})

describe('directorySize', () => {
  it('measures a real directory and reports null for a missing one', async () => {
    expect(await directorySize(repo)).toBeGreaterThan(0)
    expect(await directorySize(join(repo, 'nope'))).toBeNull()
  })
})
