import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBaseline, showFileAt } from './git-service'

/**
 * Regression cover for the session baseline.
 *
 * The bug: `createSessionBaseline` used `git stash create`, which silently
 * omits untracked files. Untracked files are exactly the class that was
 * unrecoverable in the two-agents-one-tree incident.
 *
 * `captures untracked source files` is the assertion that matters, and it has
 * been verified to FAIL against the `git stash create` implementation: a stash
 * commit has no entry for an untracked path, so `showFileAt` returns null.
 * Restoring the old body is the way to re-prove this test is not vacuous.
 */

const execFileAsync = promisify(execFile)

let repo: string

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'phosphor-baseline-'))
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@phosphor.dev'])
  await git(repo, ['config', 'user.name', 'Phosphor test'])
  await writeFile(join(repo, 'tracked.txt'), 'committed\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'initial'])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('createSessionBaseline', () => {
  it('captures untracked source files', async () => {
    await writeFile(join(repo, 'untracked.ts'), 'export const x = 1\n')

    const ref = await createSessionBaseline(repo)
    expect(ref).toBeTruthy()

    expect(await showFileAt(repo, ref as string, 'untracked.ts')).toBe('export const x = 1\n')
  })

  it('captures uncommitted edits to tracked files', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'edited\n')

    const ref = await createSessionBaseline(repo)

    expect(await showFileAt(repo, ref as string, 'tracked.txt')).toBe('edited\n')
  })

  it('leaves the working tree, the index and HEAD untouched', async () => {
    await writeFile(join(repo, 'untracked.ts'), 'export const x = 1\n')
    await writeFile(join(repo, 'tracked.txt'), 'edited\n')

    const statusBefore = await git(repo, ['status', '--porcelain'])
    const headBefore = await git(repo, ['rev-parse', 'HEAD'])

    await createSessionBaseline(repo)

    expect(await git(repo, ['status', '--porcelain'])).toBe(statusBefore)
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
  })

  it('honours .gitignore, so build output stays out of the baseline', async () => {
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repo, 'node_modules-marker.txt'), 'x\n')
    await git(repo, ['add', '.gitignore'])
    await git(repo, ['commit', '-m', 'ignore'])

    await rm(join(repo, 'node_modules-marker.txt'), { force: true })
    await execFileAsync('mkdir', ['-p', join(repo, 'node_modules')])
    await writeFile(join(repo, 'node_modules', 'big.js'), 'x'.repeat(1000))

    const ref = await createSessionBaseline(repo)

    expect(await showFileAt(repo, ref as string, 'node_modules/big.js')).toBeNull()
  })

  it('works in a repo with no commits yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'phosphor-baseline-empty-'))
    try {
      await git(fresh, ['init', '-b', 'main'])
      await writeFile(join(fresh, 'first.ts'), 'export const y = 2\n')

      const ref = await createSessionBaseline(fresh)
      expect(ref).toBeTruthy()
      expect(await showFileAt(fresh, ref as string, 'first.ts')).toBe('export const y = 2\n')
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('returns null outside a repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'phosphor-baseline-plain-'))
    try {
      expect(await createSessionBaseline(plain)).toBeNull()
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
