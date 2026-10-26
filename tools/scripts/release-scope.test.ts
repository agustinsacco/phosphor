import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { desktopReleaseScope, releaseScope } from './release-scope.mjs'

const dir = mkdtempSync(join(tmpdir(), 'release-scope-'))
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
let released: string, head: string
const runner =
  (projects: unknown, fail = false) =>
  (command: string, args: string[]) => {
    if (command === 'git') return git(...args)
    if (fail) throw Error('nx unavailable')
    return JSON.stringify(projects)
  }

beforeAll(() => {
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'Fixture')
  for (const value of ['released', 'off-history', 'head']) {
    if (value === 'off-history') {
      git('checkout', '-q', '-b', 'side')
    }
    if (value === 'head') git('checkout', '-q', '-')
    writeFileSync(join(dir, 'input'), value)
    git('add', '.')
    git('commit', '-qm', value)
    if (value === 'released') {
      released = git('rev-parse', 'HEAD')
      git('tag', 'v0.1.1')
      git('tag', 'host-v0.2.10')
    }
    if (value === 'off-history') git('tag', 'v0.1.2')
  }
  head = git('rev-parse', 'HEAD')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('desktop release scope', () => {
  it('releases when Nx reports desktop affected since the published release', () => {
    const query = vi.fn(runner(['tooling', 'desktop']))
    expect(desktopReleaseScope('v0.1.1', query)).toEqual({
      release: true,
      reason: 'desktop changed since v0.1.1',
      base: released,
      head,
      projects: ['desktop', 'tooling'],
    })
    expect(query.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining([`--base=${released}`, `--head=${head}`, '--affected']),
    )
  })

  it('does not release when only other apps changed', () => {
    expect(desktopReleaseScope('v0.1.1', runner(['site', 'tooling']))).toMatchObject({
      release: false,
      projects: ['site', 'tooling'],
    })
    expect(desktopReleaseScope('v0.1.1', runner([]))).toMatchObject({ release: false })
  })

  it.each([
    ['missing release', '', runner([])],
    ['malformed tag', 'latest', runner([])],
    ['unknown tag', 'v9.9.9', runner([])],
    ['release off this history', 'v0.1.2', runner([])],
    ['Nx failure', 'v0.1.1', runner([], true)],
    ['Nx unknown project', 'v0.1.1', runner(['site', 'mystery'])],
    ['Nx non-array', 'v0.1.1', runner({ projects: [] })],
  ])('%s releases rather than risk stranding a change', (_, tag, query) => {
    expect(desktopReleaseScope(tag, query)).toMatchObject({ release: true })
  })
})

describe('host release scope', () => {
  it('releases only when Nx reports host affected since the newest host-v tag', () => {
    expect(releaseScope('host', 'host-v0.2.10', runner(['host', 'shared']))).toEqual({
      release: true,
      reason: 'host changed since host-v0.2.10',
      base: released,
      head,
      projects: ['host', 'shared'],
    })
    expect(releaseScope('host', 'host-v0.2.10', runner(['desktop', 'site']))).toMatchObject({
      release: false,
      reason: 'host unchanged since host-v0.2.10',
    })
  })

  it('does not accept a Desktop tag as the Host baseline, or the reverse', () => {
    expect(releaseScope('host', 'v0.1.1', runner([]))).toMatchObject({ release: true })
    expect(desktopReleaseScope('host-v0.2.10', runner([]))).toMatchObject({ release: true })
  })
})
