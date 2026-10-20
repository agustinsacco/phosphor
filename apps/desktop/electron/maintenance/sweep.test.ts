import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import { addWorktree, commitAll } from '../fs/git-worktrees'
import './__fixtures__/memory-history'
import { directorySize, sweep } from './sweep'

// These tests isolate Git orchestration; conversation safety is exercised in safety.test.ts.
vi.mock('./conversations', () => ({
  conversationSnapshot: () => ({ completedAtMs: 1, lastWriteMs: 0, pinned: false }),
  conversationFacts: async () => ({
    sessions: [],
    completedAtMs: 1,
    lastWriteMs: 0,
    pinned: false,
  }),
}))

/**
 * Real git, real directories, real `du` — the same choice
 * `git-worktrees.test.ts` makes. `policy.test.ts` already covers the judgment
 * exhaustively against fabricated facts; what is untested without a real repo
 * is whether a sweep DELETES what the policy cleared and only that.
 */

// Unit tests never reach GitHub. Each test says what gh would answer.
const gh = vi.hoisted(() => ({
  heads: vi.fn<(repo: string, branch: string) => Promise<string[] | null>>(),
}))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))
vi.mock('../fs/gh-cli', () => ({ ghMergedPrHeads: gh.heads, ghCommitTree: async () => null }))

const execFileAsync = promisify(execFile)
const HOUR = 60 * 60 * 1000

let repo: string

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

/** A lane whose branch has landed on the trunk as a squash, as Phosphor lanes do. */
async function mergedLane(name: string): Promise<string> {
  const branch = `phosphor/${name}`
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
  gh.heads.mockReset().mockResolvedValue(null)
  repo = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-sweep-')))
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@phosphor.dev'])
  await git(repo, ['config', 'user.name', 'Phosphor test'])
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
    expect(await git(repo, ['branch', '--list', 'phosphor/landed'])).toBe('')
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

  it('skips a workspace that is not a git repository, without reporting an error', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'phosphor-sandbox-'))
    try {
      const report = await sweep({
        repoPath: folder,
        prefs,
        protectedPaths: [],
        liveSessionCount: 0,
        act: true,
        now: later(),
      })
      expect(report.errors).toEqual([])
      expect(report.worktreeCount).toBe(0)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('reclaims a lane only a merged PR proves, and never asks GitHub about a dirty one', async () => {
    const { path: landed } = await addWorktree(repo, 'landed', { kind: 'new', base: 'main' })
    await writeFile(join(landed, 'a.txt'), 'lane\n')
    await commitAll(landed, 'work')
    const prHead = await git(repo, ['rev-parse', 'landed'])
    await git(landed, ['commit', '--amend', '--no-edit', '--author', 'Other <o@x.dev>'])
    const { path: dirty } = await addWorktree(repo, 'dirty', { kind: 'new', base: 'main' })
    await writeFile(join(dirty, 'scratch.txt'), 'unsaved\n')
    gh.heads.mockImplementation(async (_repo, branch) => (branch === 'landed' ? [prHead] : []))

    const report = await sweep({
      repoPath: repo,
      prefs,
      protectedPaths: [],
      liveSessionCount: 0,
      act: true,
      now: later(),
    })

    expect(report.reclaimed.map((r) => r.path)).toEqual([landed])
    expect(existsSync(landed)).toBe(false)
    expect(await git(repo, ['branch', '--list', 'landed'])).toBe('')
    expect(existsSync(dirty)).toBe(true)
    expect(gh.heads.mock.calls.map(([, branch]) => branch)).not.toContain('dirty')
    expect(report.errors).toEqual([])
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
