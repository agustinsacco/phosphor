import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVersion, gitIn, listFiles, sourceDirty, writeBuildInfo } from './build-info.mjs'

const SHA = 'd'.repeat(40)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-build-info-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A git stand-in that answers `status` with `answer` and records every call. */
function fakeGit(answer: string | null) {
  return vi.fn((...args: string[]) => (args[0] === 'status' ? answer : 'unexpected'))
}

describe('listFiles', () => {
  it('lists every file below, sorted by code unit, with its size and sha256', () => {
    const files = {
      'b.txt': 'bee',
      'a/z.ts': 'zed',
      'a-b.ts': 'dash',
      'A.md': 'upper',
      'a/b/c.json': '{}',
      'phosphor.mjs.map': 'map',
      'phosphor.mjs': 'entry',
    }
    for (const [path, text] of Object.entries(files)) write(path, text)
    mkdirSync(join(dir, 'empty'))
    const order = [
      'A.md',
      'a-b.ts',
      'a/b/c.json',
      'a/z.ts',
      'b.txt',
      'phosphor.mjs',
      'phosphor.mjs.map',
    ] as const
    expect(listFiles(dir)).toEqual(
      order.map((path) => ({
        path,
        bytes: Buffer.byteLength(files[path]),
        sha256: sha256(files[path]),
      })),
    )
  })

  it('counts bytes, not characters', () => {
    write('note.md', 'é')
    expect(listFiles(dir)).toEqual([{ path: 'note.md', bytes: 2, sha256: sha256('é') }])
  })

  it('lists nothing in a folder of folders', () => {
    mkdirSync(join(dir, 'a/b'), { recursive: true })
    expect(listFiles(dir)).toEqual([])
  })
})

describe('buildVersion', () => {
  it.each([
    ['a release', SHA, '1.2.3', '1.2.3'],
    ['an unstamped release', null, '1.2.3', '1.2.3'],
    ['a stamped dev build', SHA, undefined, '0.0.0-dev.ddddddd'],
    ['an unstamped dev build', null, undefined, '0.0.0-dev.source'],
  ])('versions %s', (_, stamped, release, version) => {
    expect(buildVersion(stamped, release)).toBe(version)
  })
})

describe('sourceDirty', () => {
  it('is null, asking git nothing, when nothing is stamped', () => {
    const git = fakeGit('')
    expect(sourceDirty(null, undefined, git)).toBeNull()
    expect(sourceDirty(null, '1.2.3', git)).toBeNull()
    expect(git).not.toHaveBeenCalled()
  })

  it('counts untracked files in a dev build', () => {
    const git = fakeGit('?? notes.txt')
    expect(sourceDirty(SHA, undefined, git)).toBe(true)
    expect(git.mock.calls).toEqual([['status', '--porcelain']])
  })

  it('asks git to leave untracked files out of a release', () => {
    const git = fakeGit('')
    expect(sourceDirty(SHA, '1.2.3', git)).toBe(false)
    expect(git.mock.calls).toEqual([['status', '--porcelain', '--untracked-files=no']])
  })

  it('counts a status git could not give as dirty', () => {
    expect(sourceDirty(SHA, undefined, fakeGit(null))).toBe(true)
  })
})

describe('writeBuildInfo', () => {
  it('writes BUILD-INFO.json beside the files it lists, and returns it', () => {
    write('phosphor.mjs', 'entry')
    write('pi-ext/a.ts', 'a')
    const git = fakeGit('')
    const info = writeBuildInfo(dir, { stamped: SHA, releaseVersion: undefined, git })
    expect(info).toEqual({
      schema: 1,
      name: 'phosphor',
      version: '0.0.0-dev.ddddddd',
      sourceSha: SHA,
      sourceDirty: false,
      nodeTarget: 'node22',
      entry: 'phosphor.mjs',
      files: [
        { path: 'phosphor.mjs', bytes: 5, sha256: sha256('entry') },
        { path: 'pi-ext/a.ts', bytes: 1, sha256: sha256('a') },
      ],
    })
    const text = readFileSync(join(dir, 'BUILD-INFO.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(info, null, 2)}\n`)
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(info))
    expect(readdirSync(dir).sort()).toEqual(['BUILD-INFO.json', 'phosphor.mjs', 'pi-ext'])
  })

  it('records an unstamped release', () => {
    const info = writeBuildInfo(dir, { stamped: null, releaseVersion: '2.0.0', git: fakeGit('') })
    expect(info).toMatchObject({ version: '2.0.0', sourceSha: null, sourceDirty: null, files: [] })
  })
})

describe('gitIn', () => {
  // A GIT_DIR or GIT_WORK_TREE from a hook would point these commands at another repository.
  beforeEach(() => {
    for (const key of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) {
      vi.stubEnv(key, undefined)
    }
  })
  afterEach(() => vi.unstubAllEnvs())
  const config = ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false']
  const run = (...args: string[]) =>
    execFileSync('git', [...config, ...args], { cwd: dir, stdio: 'ignore' })

  it('runs git in the root and returns its trimmed output, or null when it fails', () => {
    run('init', '-q')
    write('tracked.txt', 'one')
    run('add', 'tracked.txt')
    run('commit', '-q', '--no-verify', '-m', 'one')
    const git = gitIn(dir)
    expect(git('rev-parse', 'HEAD')).toMatch(/^[0-9a-f]{40}$/)
    expect(git('status', '--porcelain')).toBe('')
    write('untracked.txt', 'two')
    expect(git('status', '--porcelain')).toBe('?? untracked.txt')
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(git('rev-parse', '--verify', '--quiet', 'no-such-ref')).toBeNull()
  })
})
