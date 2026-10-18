import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  changedPaths,
  commitHistory,
  frozenBlobs,
  immutableCommit,
  withSnapshot,
} from '../unit-git.mjs'

const roots: string[] = []
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'unit git spaces '))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  const commit = (files: Record<string, string>, message = 'fixture') => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    }
    git('add', '--all')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      message,
    )
    return git('rev-parse', 'HEAD')
  }
  return { root, git, commit }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('unit-git immutable histories', () => {
  it('links workspace packages to snapshot source, and cleans up on success and failure', () => {
    const { root, git, commit } = repository()
    const base = commit({
      'package.json': JSON.stringify({ workspaces: ['libs/*'] }),
      'libs/example/package.json': JSON.stringify({ name: '@fixture/example' }),
      'libs/example/entry.mjs': 'export const value = 1',
    })
    mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true })
    symlinkSync(join(root, 'libs/example'), join(root, 'node_modules/@fixture/example'), 'junction')
    writeFileSync(join(root, '.git/info/exclude'), 'node_modules\n')
    commit({ 'libs/example/entry.mjs': 'export const value = 2' })
    let snapshotPath = ''
    const check = (snapshot: string) => {
      snapshotPath = snapshot
      expect(
        readFileSync(join(snapshot, 'node_modules/@fixture/example/entry.mjs'), 'utf8'),
      ).toContain('value = 1')
    }
    withSnapshot(root, base, check)
    expect(existsSync(snapshotPath)).toBe(false)
    expect(() =>
      withSnapshot(root, base, (snapshot) => {
        check(snapshot)
        throw new Error('fixture failure')
      }),
    ).toThrow('fixture failure')
    expect(existsSync(snapshotPath)).toBe(false)
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('requires full commit object ids, not mutable refs, options or blobs', () => {
    const { root, git, commit } = repository()
    const base = commit({ 'entry.ts': 'original' })
    expect(immutableCommit(root, base)).toBe(base)
    for (const ref of ['HEAD', base.slice(0, 10), '--help', `${base}; touch injected`])
      expect(() => immutableCommit(root, ref)).toThrow(/immutable.*SHA/)
    expect(() => immutableCommit(root, git('rev-parse', `${base}:entry.ts`))).toThrow()
  })

  it('retains spaces, tabs and newlines in changed filenames and both rename endpoints', () => {
    const { root, git, commit } = repository()
    const base = commit({ 'old test.ts': 'original', 'tab\tline\n.ts': 'initial' })
    git('mv', 'old test.ts', 'new test.ts')
    const final = commit({ 'tab\tline\n.ts': 'changed' })
    expect(changedPaths(root, base, final).sort()).toEqual([
      'new test.ts',
      'old test.ts',
      'tab\tline\n.ts',
    ])
  })

  it('rejects unrelated or reversed bases and merge commits', () => {
    const { root, git, commit } = repository()
    const base = commit({ 'entry.ts': 'base' })
    const final = commit({ 'entry.ts': 'final' })
    expect(commitHistory(root, base, final)).toEqual([final])
    expect(() => commitHistory(root, final, base)).toThrow(/ancestor/)
    git('checkout', '-qb', 'side', base)
    const side = commit({ 'other.ts': 'side' })
    expect(() => commitHistory(root, final, side)).toThrow(/ancestor/)
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'merge',
      '-qm',
      'merge',
      final,
    )
    expect(() => commitHistory(root, base, git('rev-parse', 'HEAD'))).toThrow(/merge/)
  })

  it('detects an intermediate edit even if the final blob was restored', () => {
    const { root, commit } = repository()
    const first = commit({ 'entry.test.ts': 'original' })
    const edited = commit({ 'entry.test.ts': 'edited' })
    const restored = commit({ 'entry.test.ts': 'original' })
    expect(() => frozenBlobs(root, first, [edited, restored], ['entry.test.ts'])).toThrow(
      /frozen.*entry.test.ts/,
    )
  })

  it('rejects deletion and unapproved rename, permits one exact mapped move only', () => {
    const { root, git, commit } = repository()
    const first = commit({ 'old.test.ts': 'original' })
    git('mv', 'old.test.ts', 'new.test.ts')
    const moved = commit({ 'source.ts': 'implementation' })
    expect(() => frozenBlobs(root, first, [moved], ['old.test.ts'])).toThrow(/frozen/)
    const relocation = { commitSha: moved, moves: [{ from: 'old.test.ts', to: 'new.test.ts' }] }
    expect(frozenBlobs(root, first, [moved], ['old.test.ts'], relocation)).toEqual([
      {
        original: 'old.test.ts',
        file: 'new.test.ts',
        blob: git('rev-parse', `${first}:old.test.ts`),
      },
    ])
    const edited = commit({ 'new.test.ts': 'rewritten' })
    expect(() => frozenBlobs(root, first, [moved, edited], ['old.test.ts'], relocation)).toThrow(
      /frozen/,
    )
    git('rm', 'new.test.ts')
    const deleted = commit({ 'source.ts': 'next' })
    expect(() => frozenBlobs(root, moved, [deleted], ['new.test.ts'])).toThrow(/frozen/)
  })
})
