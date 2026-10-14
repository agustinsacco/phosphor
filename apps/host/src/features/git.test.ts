import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import * as runner from '@phosphor/session-runtime/git/git-exec'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { StoredLane } from '../lanes/store'
import type { FeatureContext } from './feature'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { createGitFeature } from './git'
import { createFilesFeature } from './files'

vi.mock('node:fs/promises', { spy: true })

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'host-files-'))
  const root = join(base, 'repo')
  await mkdir(root)
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Test'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await writeFile(join(root, 'tracked'), 'old\n')
  await git(root, ['add', 'tracked'])
  await git(root, ['commit', '-m', 'initial'])
  const laneId = randomUUID()
  const lane: { -readonly [K in keyof StoredLane]: StoredLane[K] } = {
    laneId,
    repositoryId: '1234567890abcdef',
    cwd: root,
    worktree: false,
    sessionFile: null,
    removedAt: null,
    title: null,
    branch: null,
    model: null,
    activity: 'idle',
    control: { fence: 1, controller: null },
    attention: 0,
    read: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const context: FeatureContext = {
    store: {
      getLane: vi.fn(() => lane),
      listRepositories: vi.fn(() => [{ id: lane.repositoryId, name: 'repo', path: root }]),
    },
    env: process.env,
    home: base,
    log: vi.fn(),
  }
  return { base, root, laneId, lane, context }
}
describe('git feature', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => {
    f = await fixture()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(f.base, { recursive: true, force: true })
  })
  const rejected = (code: string) => ({ ok: false, error: { code, message: expect.any(String) } })
  it('answers status, working and staged diffs, HEAD and hex baseline', async () => {
    const feature = createGitFeature(f.context)
    const ref = (await runner.git(f.root, ['rev-parse', 'HEAD'])).trim()
    await writeFile(join(f.root, 'tracked'), 'new\n')
    await writeFile(join(f.root, 'untracked'), 'new')
    const status = await feature.call('git.status', { laneId: f.laneId })
    expect(status).toMatchObject({
      ok: true,
      data: { status: { tracked: ' M', untracked: '??' }, ahead: 0, behind: 0 },
    })
    expect(await feature.call('git.diff', { laneId: f.laneId, path: 'tracked' })).toMatchObject({
      ok: true,
      data: { diff: expect.stringContaining('+new') },
    })
    await runner.git(f.root, ['add', 'tracked'])
    expect(await feature.call('git.diff', { laneId: f.laneId, staged: true })).toMatchObject({
      ok: true,
      data: { diff: expect.stringContaining('+new') },
    })
    for (const r of ['HEAD', ref, ref.slice(0, 8)])
      expect(await feature.call('git.show', { laneId: f.laneId, path: 'tracked', ref: r })).toEqual(
        { ok: true, data: { binary: false, size: 4, content: 'old\n' } },
      )
  })
  it('restricts subdirectory lanes to their own paths', async () => {
    await mkdir(join(f.root, 'sub'))
    await writeFile(join(f.root, 'sub', 'inside'), 'old')
    await runner.git(f.root, ['add', '.'])
    await runner.git(f.root, ['commit', '-m', 'sub'])
    await writeFile(join(f.root, 'sub', 'inside'), 'new')
    await writeFile(join(f.root, 'tracked'), 'outside')
    f.lane.cwd = join(f.root, 'sub')
    const feature = createGitFeature(f.context)
    expect(await feature.call('git.status', { laneId: f.laneId })).toMatchObject({
      ok: true,
      data: { status: { inside: ' M' } },
    })
    expect(
      await feature.call('git.show', { laneId: f.laneId, path: 'inside', ref: 'HEAD' }),
    ).toMatchObject({ ok: true, data: { content: 'old' } })
    const diff = await feature.call('git.diff', { laneId: f.laneId })
    expect(JSON.stringify(diff)).not.toContain('outside')
  })
  it('rejects refs and escaped file or parent paths and tree symlinks', async () => {
    const feature = createGitFeature(f.context)
    await symlink(f.base, join(f.root, 'escape'))
    await runner.git(f.root, ['add', 'escape'])
    await runner.git(f.root, ['commit', '-m', 'symlink'])
    for (const ref of ['--help', 'main', 'HEAD~1', 'abcd:path', ''])
      expect(await feature.call('git.show', { laneId: f.laneId, path: 'tracked', ref })).toEqual(
        rejected('bad-request'),
      )
    for (const path of ['../outside', '/etc/passwd', '.git/config', 'escape', 'escape/missing']) {
      for (const method of ['git.show', 'git.diff'])
        expect(
          await feature.call(method, {
            laneId: f.laneId,
            path,
            ...(method === 'git.show' ? { ref: 'HEAD' } : {}),
          }),
        ).toEqual(rejected('bad-request'))
    }
    await rm(join(f.root, 'escape'))
    expect(
      await feature.call('git.show', { laneId: f.laneId, path: 'escape', ref: 'HEAD' }),
    ).toEqual(rejected('bad-request'))
  })
  it('rejects parent escapes before a whole-tree or directory diff', async () => {
    await mkdir(join(f.root, 'dir'))
    await writeFile(join(f.root, 'dir', 'file'), 'original')
    await runner.git(f.root, ['add', '.'])
    await runner.git(f.root, ['commit', '-m', 'directory'])
    await rm(join(f.root, 'dir'), { recursive: true })
    await writeFile(join(f.base, 'file'), 'secret')
    await symlink(f.base, join(f.root, 'dir'))
    const feature = createGitFeature(f.context)
    expect(await feature.call('git.diff', { laneId: f.laneId })).toEqual(rejected('bad-request'))
    expect(await feature.call('git.diff', { laneId: f.laneId, path: 'dir' })).toEqual(
      rejected('bad-request'),
    )
  })
  it('caps blobs before reading, classifies binary, and disables external diff', async () => {
    await writeFile(join(f.root, 'large'), 'x'.repeat(FILE_LIMITS.textBytes + 1))
    await writeFile(join(f.root, 'binary'), Buffer.from([0, 255]))
    await runner.git(f.root, ['add', '.'])
    await runner.git(f.root, ['commit', '-m', 'blobs'])
    const spy = vi.spyOn(runner, 'git')
    const feature = createGitFeature(f.context)
    expect(
      await feature.call('git.show', { laneId: f.laneId, path: 'large', ref: 'HEAD' }),
    ).toEqual(rejected('too-large'))
    expect(spy.mock.calls.some(([, args]) => args.includes('blob'))).toBe(false)
    expect(
      await feature.call('git.show', { laneId: f.laneId, path: 'binary', ref: 'HEAD' }),
    ).toMatchObject({ ok: true, data: { binary: true, size: 2 } })
    await writeFile(join(f.root, 'tracked'), 'changed')
    await runner.git(f.root, ['config', 'diff.external', '/bin/false'])
    expect((await feature.call('git.diff', { laneId: f.laneId })).ok).toBe(true)
    expect(
      spy.mock.calls
        .filter(([, a]) => a.includes('diff'))
        .every(
          ([, a]) =>
            a.includes('--no-ext-diff') &&
            a.includes('--no-textconv') &&
            a.includes('core.fsmonitor=false') &&
            a.includes('--no-pager'),
        ),
    ).toBe(true)
  })
  it('caps lists and diffs without truncation at exact boundaries', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).realpath
    vi.spyOn(fs, 'realpath').mockImplementation(async (path, options) => {
      if (String(path).includes('/missing'))
        throw Object.assign(new Error('Missing'), { code: 'ENOENT' })
      return original(path, options)
    })
    const spy = vi.spyOn(runner, 'git')
    spy.mockResolvedValue(
      Array(FILE_LIMITS.entries)
        .fill('tracked')
        .map((_, i) => `missing${i}\0`)
        .join(''),
    )
    expect((await createFilesFeature(f.context).call('files.list', { laneId: f.laneId })).ok).toBe(
      true,
    )
    spy.mockResolvedValue(
      Array(FILE_LIMITS.entries + 1)
        .fill('tracked')
        .map((_, i) => `missing${i}\0`)
        .join(''),
    )
    expect(await createFilesFeature(f.context).call('files.list', { laneId: f.laneId })).toEqual(
      rejected('too-large'),
    )
    spy.mockImplementation(async (_cwd, args) =>
      args.includes('ls-files') ? 'tracked\0' : 'x'.repeat(FILE_LIMITS.textBytes),
    )
    expect((await createGitFeature(f.context).call('git.diff', { laneId: f.laneId })).ok).toBe(true)
    spy.mockImplementation(async (_cwd, args) =>
      args.includes('ls-files') ? 'tracked\0' : 'x'.repeat(FILE_LIMITS.textBytes + 1),
    )
    expect(await createGitFeature(f.context).call('git.diff', { laneId: f.laneId })).toEqual(
      rejected('too-large'),
    )
  })
})
