import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirtyCount, git, gitErrorText } from './git-exec'

/**
 * `dirtyCount` unified four implementations that disagreed on trailing
 * newlines: `git status --porcelain` always ends in one, so the versions that
 * split the raw string counted a phantom entry, and the ones that skipped the
 * empty-string guard reported a clean tree as dirty. Real git, real repo —
 * the newline is the whole point, so a fixture string would prove nothing.
 */

const execFileAsync = promisify(execFile)

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'phosphor-git-exec-'))
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.email', 'test@phosphor.dev'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.name', 'Phosphor test'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await execFileAsync('git', ['add', '-A'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo })
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('dirtyCount', () => {
  it('reports 0 for a clean tree (empty porcelain output)', async () => {
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
    expect(await dirtyCount(repo)).toBe(0)
  })

  it('reports 1 for one modified file, not 2 for its trailing newline', async () => {
    await writeFile(join(repo, 'a.txt'), 'dirty\n')
    expect(await git(repo, ['status', '--porcelain'])).toBe(' M a.txt\n')
    expect(await dirtyCount(repo)).toBe(1)
  })

  it('counts every entry when several files are dirty', async () => {
    await writeFile(join(repo, 'a.txt'), 'dirty\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')
    await writeFile(join(repo, 'c.txt'), 'new\n')
    expect(await dirtyCount(repo)).toBe(3)
  })
})

describe('git', () => {
  it('trims only when asked', async () => {
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main\n')
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { trim: true })).toBe('main')
  })

  it('swallows a failing command only under allowFail', async () => {
    await expect(git(repo, ['rev-parse', 'no-such-ref'])).rejects.toThrow()
    expect(await git(repo, ['rev-parse', 'no-such-ref'], { allowFail: true })).toBe('')
  })
})

describe('gitErrorText', () => {
  it("keeps git's reason and drops the command echo and hints", () => {
    const error = Object.assign(new Error('Command failed: git branch -d task-1\nerror: x'), {
      stderr:
        "error: the branch 'task-1' is not fully merged\n" +
        "hint: If you are sure you want to delete it, run 'git branch -D task-1'\n",
    })
    expect(gitErrorText(error)).toBe("the branch 'task-1' is not fully merged")
  })

  it('falls back to the first line when there is no stderr', () => {
    expect(gitErrorText(new Error('spawn git ENOENT\nsecond line'))).toBe('spawn git ENOENT')
    expect(gitErrorText('plain string')).toBe('plain string')
  })
})
