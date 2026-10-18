import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkRepositories, confineToRoots, isInsideRoot } from './repositories'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
const actualFs = await vi.importActual<typeof filesystem>('node:fs/promises')

const environment = { env: { PATH: '/usr/bin:/bin' }, secrets: [] }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-repositories-fs-'))
})
afterEach(() => {
  vi.mocked(filesystem.realpath).mockReset()
  rmSync(dir, { recursive: true, force: true })
})

describe('isInsideRoot(candidate, root) (characterization)', () => {
  it.each([
    // Root-inclusive, whole segments.
    ['/repo', '/repo', true],
    ['/repo/src', '/repo', true],
    ['/repo/src/deep', '/repo', true],
    ['/repo2', '/repo', false],
    ['/rep', '/repo', false],
    ['/', '/repo', false],
    ['/other/repo', '/repo', false],
    // The filesystem root holds every absolute path, and nothing relative.
    ['/', '/', true],
    ['/anything', '/', true],
    ['/a/b', '/', true],
    ['relative', '/', false],
    ['', '/', false],
    // Trailing separators are compared as written, not normalized.
    ['/repo/', '/repo', true],
    ['/repo/src/', '/repo', true],
    ['/repo2/', '/repo', false],
    ['/repo', '/repo/', false],
    ['/repo/src', '/repo/', false],
    ['/repo/', '/repo/', true],
    ['/repo//src', '/repo/', true],
    // A child named `..b` is inside; dot segments are not resolved.
    ['/a/..b', '/a', true],
    ['/a..b', '/a', false],
    ['/a/../b', '/a', true],
    ['/a/.', '/a', true],
    // Relative and empty paths are compared as strings too.
    ['repo/src', 'repo', true],
    ['repo2', 'repo', false],
    ['', '', true],
    ['/x', '', true],
  ])('isInsideRoot(%j, %j) is %s', (candidate, root, expected) => {
    expect(isInsideRoot(candidate, root)).toBe(expected)
  })
})

describe('repository containment through its callers (characterization)', () => {
  it('confines only real paths inside a configured root', async () => {
    const root = join(dir, 'repo')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(dir, 'repo2'))
    mkdirSync(join(dir, 'a..b'))
    symlinkSync(join(dir, 'repo2'), join(root, 'escape'))
    expect(await confineToRoots(root, [root])).toBe(root)
    expect(await confineToRoots(`${root}/`, [root])).toBe(root)
    expect(await confineToRoots(join(root, 'src'), [root])).toBe(join(root, 'src'))
    expect(await confineToRoots(`${root}/src/../src`, [root])).toBe(join(root, 'src'))
    expect(await confineToRoots(join(dir, 'repo2'), [root])).toBeNull()
    expect(await confineToRoots(join(root, 'escape'), [root])).toBeNull()
    expect(await confineToRoots(`${root}/../repo2`, [root])).toBeNull()
    expect(await confineToRoots(join(dir, 'a..b'), [join(dir, 'a')])).toBeNull()
    expect(await confineToRoots(join(root, 'src'), ['/'])).toBe(join(root, 'src'))
    expect(await confineToRoots(join(root, 'src'), [`${root}/`])).toBeNull()
    expect(await confineToRoots('repo', [root])).toBeNull()
  })

  it('calls a root broad when it holds the home folder, not when it is a sibling or inside it', async () => {
    const home = join(dir, 'home')
    for (const path of [home, `${home}2`, join(home, 'project')]) mkdirSync(path)
    const result = await checkRepositories([home, `${home}2`, join(home, 'project'), dir], {
      home,
      git: null,
      environment,
    })
    expect(result.roots).toEqual([home, `${home}2`, join(home, 'project'), dir])
    expect(
      result.checks.map((check) => [check.status, check.summary.includes('very broad')]),
    ).toEqual([
      ['warn', true],
      ['info', false],
      ['info', false],
      ['warn', true],
    ])
  })
})

describe('repository folder errors (characterization)', () => {
  it('reports a missing folder as missing and any other error by its text', async () => {
    const file = join(dir, 'file')
    writeFileSync(file, '')
    symlinkSync(join(dir, 'loop'), join(dir, 'loop'))
    const result = await checkRepositories(
      [join(dir, 'missing'), join(file, 'below'), join(dir, 'loop')],
      { home: join(dir, 'home'), git: null, environment },
    )
    expect(result.roots).toEqual([])
    expect(result.checks.map((check) => [check.status, check.summary])).toEqual([
      ['fail', `${join(dir, 'missing')} does not exist`],
      ['fail', expect.stringContaining(`${join(file, 'below')} ENOTDIR: `)],
      ['fail', expect.stringContaining(`${join(dir, 'loop')} ELOOP: `)],
    ])
  })

  it('reads the code of any rejected object, Error or not', async () => {
    const reasons: Record<string, unknown> = {
      [join(dir, 'record')]: { code: 'ENOENT' },
      [join(dir, 'error')]: Object.assign(new Error('gone'), { code: 'ENOENT' }),
      [join(dir, 'other')]: Object.assign(new Error('denied'), { code: 'EACCES' }),
      [join(dir, 'numeric')]: { code: 2, message: 'numeric code' },
      [join(dir, 'text')]: 'ENOENT',
    }
    vi.mocked(filesystem.realpath).mockImplementation(async (path, options) => {
      const reason = reasons[String(path)]
      if (reason !== undefined) throw reason
      return actualFs.realpath(path, options)
    })
    const result = await checkRepositories(Object.keys(reasons), {
      home: join(dir, 'home'),
      git: null,
      environment,
    })
    expect(result.checks.map((check) => check.summary)).toEqual([
      `${join(dir, 'record')} does not exist`,
      `${join(dir, 'error')} does not exist`,
      `${join(dir, 'other')} denied`,
      `${join(dir, 'numeric')} numeric code`,
      `${join(dir, 'text')} ENOENT`,
    ])
  })
})
