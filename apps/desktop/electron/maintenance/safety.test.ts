import './__fixtures__/memory-history'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_PREFS, DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import { addWorktree } from '../fs/git-worktrees'
import { sessionDirForCwd } from '../pi/pi-paths'
import { listSessions } from '../pi/session-scanner'
import { conversationFacts, retainedWorkspaces, setCompleted } from './conversations'
import { decideSession, history, recordWorkspaceIntent } from './history'
import * as gitExec from '@phosphor/session-runtime/git/git-exec'
import { removeCompletedWorktree, restoreWorktree } from './removal'
import { sweep } from './sweep'
import type { WorktreeFacts } from './policy'

const state = vi.hoisted(() => ({
  prefs: null as unknown as typeof DEFAULT_APP_PREFS,
  live: [] as Array<{ workspacePath: string }>,
}))
vi.mock('../store', () => ({ getPrefs: () => state.prefs }))
vi.mock('../registry', () => ({ registry: { list: () => state.live } }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))
vi.mock('../fs/gh-cli', () => ({ ghMergedPrHeads: async () => [], ghCommitTree: async () => null }))

const exec = promisify(execFile)
const HOUR = 3_600_000
let root: string
let repo: string
let lane: string
let transcript: string
let initial: string
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd })).stdout.trim()

async function writeTranscript(id: string): Promise<string> {
  const dir = sessionDirForCwd(lane)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `2026-09-01_${id}.jsonl`)
  await writeFile(
    path,
    `${JSON.stringify({ type: 'session', version: 3, id, cwd: lane, timestamp: '2026-09-01T00:00:00Z' })}\n`,
  )
  return path
}

beforeEach(async () => {
  // Reset persistent test state without replacing the lazy store instance.
  history().set('sessions', {})
  history().set('removals', [])
  state.prefs = structuredClone(DEFAULT_APP_PREFS)
  state.live = []
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-conversation-safety-')))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'readme'), 'original\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'initial')
  initial = await git(repo, 'rev-parse', 'HEAD')
  lane = (await addWorktree(repo, 'research', { kind: 'new', base: 'main', branch: 'research' }))
    .path
  transcript = await writeTranscript('conversation-a')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const run = (now = Date.now() + 48 * HOUR) =>
  sweep({
    repoPath: repo,
    prefs: DEFAULT_MAINTENANCE_PREFS,
    protectedPaths: [],
    liveSessionCount: 0,
    act: true,
    now,
  })

it('keeps a stopped, ancestry-merged research conversation with no PR and no decision', async () => {
  const report = await run()
  expect(report.held.find((w) => w.path === lane)?.reason).toBe('unfinished')
  expect(report.reclaimed).toEqual([])
  expect(existsSync(lane)).toBe(true)
})

it('requires every conversation in a shared worktree to be finished', async () => {
  decideSession(transcript, true)
  await writeTranscript('conversation-b')
  expect((await run()).reclaimed).toEqual([])
  expect((await conversationFacts(lane)).completedAtMs).toBeNull()
})

it('uses transcript files, not old directory mtimes, for the grace period', async () => {
  const now = Date.now()
  const old = new Date(now - 72 * HOUR)
  decideSession(transcript, true, old.getTime())
  await utimes(lane, old, old)
  await utimes(sessionDirForCwd(lane), old, old)
  await writeFile(transcript, `${await readFile(transcript, 'utf8')}\n`)
  const report = await run(now)
  expect(report.held.find((w) => w.path === lane)?.reason).toBe('too-recent')
  expect(existsSync(lane)).toBe(true)
  expect((await conversationFacts(lane)).lastWriteMs).toBeGreaterThan(now - HOUR)
})

it('protects persisted user interaction even without a transcript write', async () => {
  const now = Date.now()
  const old = new Date(now - 72 * HOUR)
  decideSession(transcript, true, old.getTime())
  await utimes(transcript, old, old)
  await utimes(lane, old, old)
  await utimes(sessionDirForCwd(lane), old, old)
  state.prefs.seenSessions[transcript] = now
  expect((await run(now)).held.find((w) => w.path === lane)?.reason).toBe('too-recent')
})

it.each(['pin', 'lock'] as const)('protects a finished worktree with a %s', async (protection) => {
  decideSession(transcript, true)
  if (protection === 'pin') state.prefs.pinnedSessions = [transcript]
  else await git(repo, 'worktree', 'lock', '--reason', 'unfinished conversation', lane)
  const report = await run()
  expect(report.reclaimed).toEqual([])
  expect(report.held.find((w) => w.path === lane)?.reason).toBe(
    protection === 'pin' ? 'pinned' : 'locked',
  )
})

it('reclaims an explicitly finished lane, retains discovery and restores the exact tip and conversation', async () => {
  const before = await readFile(transcript, 'utf8')
  decideSession(transcript, true)
  const report = await run()
  expect(report.errors).toEqual([])
  expect(report.reclaimed.map((w) => w.path)).toEqual([lane])
  expect(existsSync(lane)).toBe(false)
  const record = history().get('removals')[0]!
  expect(record).toMatchObject({
    repoPath: repo,
    path: lane,
    branch: 'research',
    tip: initial,
    outcome: 'removed',
    reason: 'explicitly-completed-and-merged',
  })
  expect(record.sessions).toEqual([
    expect.objectContaining({
      id: 'conversation-a',
      path: transcript,
      completedAt: expect.any(Number),
      activityAt: expect.any(Number),
    }),
  ])
  expect(await git(repo, 'rev-parse', record.recoveryRef)).toBe(initial)
  expect(await retainedWorkspaces(repo)).toContain(lane)
  expect((await listSessions(lane))[0]?.sessionId).toBe('conversation-a')
  await restoreWorktree(lane)
  expect(await git(lane, 'rev-parse', 'HEAD')).toBe(initial)
  expect(await readFile(transcript, 'utf8')).toBe(before)
  expect((await listSessions(lane))[0]?.path).toBe(transcript)
})

it('discovers legacy histories after a checkout and git registration are removed', async () => {
  await git(repo, 'worktree', 'remove', lane)
  await git(repo, 'worktree', 'prune')
  expect(history().get('removals')).toEqual([])
  expect(await retainedWorkspaces(repo)).toContain(lane)
  await expect(restoreWorktree(lane)).rejects.toThrow('No saved checkout identity')
})

it('a resume intent between scan and deletion prevents removal', async () => {
  decideSession(transcript, true)
  const facts: WorktreeFacts = {
    path: lane,
    realPath: lane,
    branch: 'research',
    isMain: false,
    dirtyCount: 0,
    merged: true,
    bytes: 0,
    ...(await conversationFacts(lane)),
  }
  await expect(
    removeCompletedWorktree(
      repo,
      lane,
      async () => {
        // Same synchronous invalidation as Desktop admission, before its first await.
        decideSession(transcript, false)
        return facts
      },
      () => ({ protectedPaths: [], now: Date.now() + 48 * HOUR, minAgeHours: 24 }),
    ),
  ).rejects.toThrow('resumed or changed')
  expect(existsSync(lane)).toBe(true)
  expect(history().get('removals')[0]?.outcome).toBe('error')
})

it.each(['resume', 'new-session'] as const)(
  'stops a %s intent arriving inside the final Git scan',
  async (kind) => {
    decideSession(transcript, true)
    const originalGit = gitExec.git
    let raced = false
    vi.spyOn(gitExec, 'git').mockImplementation(async (cwd, args, options) => {
      const result = await originalGit(cwd, args, options)
      if (args[0] === 'worktree' && args[1] === 'list' && history().get('removals').length) {
        raced = true
        recordWorkspaceIntent(lane)
        if (kind === 'resume') decideSession(transcript, false)
      }
      return result
    })
    const report = await run()
    expect(raced).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(existsSync(lane)).toBe(true)
    expect(report.errors.join()).toContain('resumed or changed')
  },
)

it('refuses to remove a checkout whose tip changed after the recovery identity was saved', async () => {
  decideSession(transcript, true)
  const originalGit = gitExec.git
  vi.spyOn(gitExec, 'git').mockImplementation(async (cwd, args, options) => {
    const result = await originalGit(cwd, args, options)
    if (args[0] === 'update-ref' && args[1]?.startsWith('refs/phosphor/recovery/'))
      await git(lane, 'commit', '--allow-empty', '-m', 'new unmerged work')
    return result
  })
  const report = await run()
  expect(report.reclaimed).toEqual([])
  expect(existsSync(lane)).toBe(true)
  expect(await git(lane, 'rev-parse', 'HEAD')).not.toBe(initial)
  expect(report.errors.join()).toContain('identity changed')
})

it('refuses completion while any session still owns the checkout', async () => {
  state.live = [{ workspacePath: lane }]
  await expect(setCompleted(transcript, true)).rejects.toThrow('Suspend all sessions')
  expect((await conversationFacts(lane)).completedAtMs).toBeNull()
  state.live = []
  await setCompleted(transcript, true)
  expect((await conversationFacts(lane)).completedAtMs).toBeGreaterThan(0)
})

it('persists completion decisions and unknown protection across a process restart', async () => {
  decideSession(transcript, true)
  vi.resetModules()
  const restarted = await import('./history')
  expect(restarted.sessionDecision(transcript).completedAt).toBeGreaterThan(0)
  expect(restarted.sessionDecision(join(root, 'legacy.jsonl')).completedAt).toBeUndefined()
  expect((await stat(transcript)).isFile()).toBe(true)
})
