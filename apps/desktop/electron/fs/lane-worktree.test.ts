import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitExec from '@phosphor/session-runtime/git/git-exec'

const calls = vi.hoisted(() => [] as string[][])
vi.mock('@phosphor/session-runtime/git/git-exec', async (original) => {
  const real = await original<typeof GitExec>()
  return {
    ...real,
    git: (cwd: string, args: string[], options?: GitExec.GitOptions) => {
      calls.push(args)
      return real.git(cwd, args, options)
    },
  }
})
vi.mock('./gh-cli', () => ({ ghEvidence: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

import { createLaneWorktree } from './lane-worktree'

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd })).stdout.trim()
let repo: string

beforeEach(async () => {
  calls.length = 0
  repo = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-lane-')))
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

const request = { title: 'Fix the composer', prefix: 'phosphor/' }

it('cuts a named lane worktree off trunk without reading any checkout status', async () => {
  const result = await createLaneWorktree(repo, request)
  expect(result).toMatchObject({
    kind: 'created',
    repoPath: repo,
    worktree: {
      path: join(repo, '.phosphor', 'worktrees', 'fix-the-composer'),
      branch: 'phosphor/fix-the-composer',
      isMain: false,
      dirtyCount: 0,
    },
  })
  if (result.kind !== 'created') return
  expect(result.worktree.head).toBe(await git(repo, ['rev-parse', 'main']))
  expect(await git(result.worktree.path, ['status', '--porcelain'])).toBe('')
  expect(calls.some((args) => args[0] === 'status')).toBe(false)
})

it('skips names a branch or a folder already holds', async () => {
  await git(repo, ['branch', 'phosphor/fix-the-composer'])
  await mkdir(join(repo, '.phosphor', 'worktrees', 'fix-the-composer-2'), { recursive: true })
  const result = await createLaneWorktree(repo, request)
  expect(result).toMatchObject({
    kind: 'created',
    worktree: { branch: 'phosphor/fix-the-composer-3' },
  })
})

it('branches in the main tree when started from a linked worktree', async () => {
  const first = await createLaneWorktree(repo, request)
  if (first.kind !== 'created') throw new Error('expected a worktree')
  const second = await createLaneWorktree(first.worktree.path, { ...request, title: 'Next' })
  expect(second).toMatchObject({
    kind: 'created',
    repoPath: repo,
    worktree: { path: join(repo, '.phosphor', 'worktrees', 'next'), branch: 'phosphor/next' },
  })
})

it('runs in place outside git', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'phosphor-plain-'))
  try {
    expect(await createLaneWorktree(plain, request)).toEqual({ kind: 'unisolated' })
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

it("returns git's reason when it refuses, rather than throwing", async () => {
  await mkdir(join(repo, '.git', 'refs', 'heads', 'phosphor'), { recursive: true })
  await writeFile(join(repo, '.git', 'refs', 'heads', 'phosphor', 'fix-the-composer.lock'), '')
  const result = await createLaneWorktree(repo, request)
  expect(result).toMatchObject({
    kind: 'failed',
    repoPath: repo,
    branch: 'phosphor/fix-the-composer',
  })
  if (result.kind === 'failed') expect(result.error).toMatch(/lock/i)
})
