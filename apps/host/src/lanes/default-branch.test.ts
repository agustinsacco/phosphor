import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { defaultBranchRefs, resolveDefaultBranch, type RepositoryGit } from './default-branch'

let temp: string
let root: string
const run: RepositoryGit = (args) => git(root, args, { isolateEnv: true, trim: true })
const resolve = () => resolveDefaultBranch(run)
beforeEach(async () => {
  temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'default-branch-')))
  root = join(temp, 'repo')
  await git(temp, ['init', '-b', 'develop', root], { isolateEnv: true })
  await run(['config', 'user.name', 'Default branch test'])
  await run(['config', 'user.email', 'default@example.invalid'])
  await run(['commit', '--allow-empty', '-m', 'base'])
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

it('takes the current branch when it is the only candidate, as in a develop-only repository', async () => {
  expect(await resolve()).toBe('develop')
  await run(['checkout', '-b', 'feature/current'])
  expect(await resolve()).toBe('feature/current')
})

it('prefers an existing main over master, and master over the current branch', async () => {
  await run(['branch', 'master'])
  expect(await resolve()).toBe('master')
  await run(['branch', 'main'])
  expect(await resolve()).toBe('main')
  await run(['branch', '-D', 'main'])
  await run(['branch', 'main/nested'])
  expect(await resolve()).toBe('master')
})

it("takes origin/HEAD's branch first, even when its remote ref is missing", async () => {
  await run(['branch', 'main'])
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk/next'])
  expect(await resolve()).toBe('trunk/next')
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/develop'])
  expect(await resolve()).toBe('main')
  await run(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
  await run(['update-ref', 'refs/remotes/origin/HEAD', 'develop'])
  expect(await resolve()).toBe('main')
})

it('returns null for a detached or unborn HEAD without candidates, never literal HEAD', async () => {
  await run(['checkout', '--detach'])
  expect(await resolve()).toBeNull()
  await run(['branch', 'master'])
  expect(await resolve()).toBe('master')
  await run(['branch', '-D', 'master'])
  await run(['checkout', '--orphan', 'unborn'])
  expect(await resolve()).toBeNull()
  await run(['branch', '-m', 'develop', 'main'])
  expect(await resolve()).toBe('main')
})

it('rejects when refs cannot be listed and treats a failed symbolic-ref as absent', async () => {
  root = temp
  await expect(resolve()).rejects.toThrow()
  root = join(temp, 'repo')
  const calls: string[][] = []
  const failing: RepositoryGit = (args) => {
    calls.push(args)
    return args[0] === 'symbolic-ref' ? Promise.reject(new Error('private')) : run(args)
  }
  await run(['branch', 'master'])
  expect(await resolveDefaultBranch(failing)).toBe('master')
  expect(calls.map((args) => args[0])).toEqual(['symbolic-ref', 'symbolic-ref', 'for-each-ref'])
  await run(['branch', '-m', 'master', 'other'])
  expect(await resolveDefaultBranch(failing)).toBeNull()
})

it('names the trunk refs freshest first', () => {
  expect(defaultBranchRefs('develop')).toEqual([
    'refs/remotes/origin/develop',
    'refs/heads/develop',
  ])
})
