import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_PREFS } from '@shared/models'
import { addWorktree } from '../../fs/git-worktrees'
import { sessionDirForCwd } from '../../pi/pi-paths'
import { listSessions } from '../../pi/session-scanner'
import { history } from '../history'
import { recreateWorktree, worktreeRecovery } from '../recovery'
import type { SafetyState } from './safety-cases'

/**
 * Recreating a removed checkout, shared by both runtime modes:
 * `recovery.test.ts` runs it in-app and `recovery.daemon.test.ts` with This
 * Mac's lanes in the service. Each suite owns its mocks and `state`.
 */
let state: SafetyState
const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd })).stdout.trim()

export const header = (cwd: string) =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'conv',
    cwd,
    timestamp: '2026-10-01T00:00:00Z',
  })
export const toolCall = (name: string, args: Record<string, unknown>, id = name) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-10-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
  })

let root: string
let repo: string
let lane: string
let transcript: string
let original: string
let initial: string

function setup(): void {
  beforeEach(async () => {
    history().set('sessions', {})
    history().set('removals', [])
    state.prefs = structuredClone(DEFAULT_APP_PREFS)
    state.live = []
    root = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-recovery-')))
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
    lane = (
      await addWorktree(repo, 'research', { kind: 'new', base: 'main', branch: 'agustin/research' })
    ).path
    await writeFile(join(lane, 'notes.md'), 'lane work\n')
    await git(lane, 'add', '.')
    await git(lane, 'commit', '-m', 'lane work')
    const dir = sessionDirForCwd(lane)
    await mkdir(dir, { recursive: true })
    transcript = join(dir, '2026-10-01_conv.jsonl')
    original = `${header(lane)}\n${toolCall('write', { path: `${lane}/notes.md` })}\n`
    await writeFile(transcript, original)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
}

const removeCheckout = async () => {
  await git(repo, 'worktree', 'remove', '--force', lane)
  expect(existsSync(lane)).toBe(false)
}

function recreateCases(): void {
  it('offers the matching branch for a legacy removal and checks it out in place', async () => {
    await removeCheckout()
    const recovery = await worktreeRecovery(lane)
    expect(recovery.saved).toBeUndefined()
    expect(recovery.branch).toMatchObject({
      name: 'agustin/research',
      subject: 'lane work',
      remoteOnly: false,
    })
    expect(recovery.fresh).toEqual({ base: 'main', branch: 'phosphor/research' })
    expect(recovery).toMatchObject({ editedFiles: ['notes.md'], editedFileCount: 1 })
    await recreateWorktree(lane, 'branch')
    expect(await git(lane, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agustin/research')
    expect(await readFile(join(lane, 'notes.md'), 'utf8')).toBe('lane work\n')
    expect(await readFile(transcript, 'utf8')).toBe(original)
    expect((await listSessions(lane))[0]?.path).toBe(transcript)
  })

  it('starts a new branch from trunk when the old branch is gone', async () => {
    await removeCheckout()
    await git(repo, 'branch', '-D', 'agustin/research')
    const recovery = await worktreeRecovery(lane)
    expect(recovery.branch).toBeUndefined()
    expect(recovery.unavailable).toBeUndefined()
    await expect(recreateWorktree(lane, 'branch')).rejects.toThrow('No single matching branch')
    expect(existsSync(lane)).toBe(false)
    await recreateWorktree(lane, 'fresh')
    expect(await git(lane, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('phosphor/research')
    expect(await git(lane, 'rev-parse', 'HEAD')).toBe(initial)
    expect(await readFile(transcript, 'utf8')).toBe(original)
  })

  it('names a fresh branch past existing ones', async () => {
    await git(repo, 'branch', 'phosphor/research', 'main')
    await git(repo, 'branch', 'phosphor/research-2', 'main')
    await removeCheckout()
    const recovery = await worktreeRecovery(lane)
    expect(recovery.fresh?.branch).toBe('phosphor/research-3')
    // Several branches match the folder; the configured prefix breaks the tie.
    expect(recovery.branch?.name).toBe('phosphor/research')
  })
}

function refusalCases(): void {
  it('recovers a checkout deleted behind git, using its stale registration', async () => {
    const other = (await addWorktree(repo, 'other', { kind: 'new', base: 'main' })).path
    await rm(lane, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
    expect((await worktreeRecovery(lane)).branch?.name).toBe('agustin/research')
    await recreateWorktree(lane, 'branch')
    expect(await git(lane, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agustin/research')
    // Only this path's registration is dropped; other stale entries stay for the user.
    expect(await git(repo, 'worktree', 'list')).toContain(other)
  })

  it('refuses existing, live, locked and out-of-layout checkouts', async () => {
    await expect(recreateWorktree(lane, 'fresh')).rejects.toThrow('already exists')
    expect((await worktreeRecovery(lane)).unavailable).toBe('This checkout already exists.')
    await git(repo, 'worktree', 'lock', lane)
    await rm(lane, { recursive: true, force: true })
    expect((await worktreeRecovery(lane)).unavailable).toContain('locked')
    await expect(recreateWorktree(lane, 'fresh')).rejects.toThrow('locked')
    state.live = [{ workspacePath: lane }]
    await expect(recreateWorktree(lane, 'fresh')).rejects.toThrow('already running')
    state.live = []
    const outside = join(root, 'loose-checkout')
    expect((await worktreeRecovery(outside)).unavailable).toContain('outside .phosphor/worktrees')
    await expect(recreateWorktree(lane, 'other' as 'fresh')).rejects.toThrow('Unknown')
  })
}

export function recoveryCases(suiteState: SafetyState): void {
  state = suiteState
  setup()
  recreateCases()
  refusalCases()
}
