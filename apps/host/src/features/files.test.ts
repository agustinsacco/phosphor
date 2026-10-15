import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import type { FeatureContext } from './feature'
import type { StoredLane } from '../lanes/store'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { checkedPath, createFilesFeature, inside, laneRoot } from './files'

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
describe('files feature', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => {
    f = await fixture()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(f.base, { recursive: true, force: true })
  })
  const code = (c: string) => ({ ok: false, error: { code: c, message: expect.any(String) } })
  it('lists tracked and non-ignored files and reads text and binary', async () => {
    await writeFile(join(f.root, '.gitignore'), 'ignored\n')
    await writeFile(join(f.root, 'ignored'), 'secret')
    await writeFile(join(f.root, 'binary'), Buffer.from([0, 255, 1]))
    const feature = createFilesFeature(f.context)
    expect(await feature.call('files.list', { laneId: f.laneId })).toEqual({
      ok: true,
      data: { files: expect.arrayContaining(['tracked', 'binary', '.gitignore']) },
    })
    const list = await feature.call('files.list', { laneId: f.laneId })
    expect(JSON.stringify(list)).not.toContain('ignored')
    expect(await feature.call('files.read', { laneId: f.laneId, path: 'tracked' })).toEqual({
      ok: true,
      data: {
        binary: false,
        size: 4,
        content: 'old\n',
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(await feature.call('files.read', { laneId: f.laneId, path: 'binary' })).toEqual({
      ok: true,
      data: { binary: true, size: 3, revision: expect.any(String) },
    })
  })
  it('reads only configured repositories, with the lane confinement and size guards', async () => {
    const feature = createFilesFeature(f.context)
    const repositoryId = f.lane.repositoryId
    expect(await feature.call('files.list', { repositoryId })).toEqual({
      ok: true,
      data: { files: ['tracked'] },
    })
    expect(await feature.call('files.read', { repositoryId, path: 'tracked' })).toMatchObject({
      ok: true,
      data: { content: 'old\n' },
    })
    expect(await feature.call('files.list', { repositoryId: '0000000000000000' })).toEqual(
      code('bad-request'),
    )
    await writeFile(join(f.base, 'secret'), 'outside')
    await symlink(join(f.base, 'secret'), join(f.root, 'escape'))
    expect(await feature.call('files.read', { repositoryId, path: 'escape' })).toEqual(
      code('bad-request'),
    )
    expect(await feature.call('files.read', { repositoryId, path: '.git/config' })).toEqual(
      code('bad-request'),
    )
    await writeFile(join(f.root, 'large'), 'x'.repeat(FILE_LIMITS.textBytes + 1))
    expect(await feature.call('files.read', { repositoryId, path: 'large' })).toEqual(
      code('too-large'),
    )
  })
  it('refuses a repository removed during the read', async () => {
    const repositories = f.context.store.listRepositories()
    vi.mocked(f.context.store.listRepositories)
      .mockReturnValueOnce(repositories)
      .mockReturnValue([])
    expect(
      await createFilesFeature(f.context).call('files.read', {
        repositoryId: f.lane.repositoryId,
        path: 'tracked',
      }),
    ).toEqual(code('bad-request'))
  })
  it('enforces text cap at and above the boundary, including large binary', async () => {
    const feature = createFilesFeature(f.context)
    await writeFile(join(f.root, 'large'), 'x'.repeat(FILE_LIMITS.textBytes))
    expect((await feature.call('files.read', { laneId: f.laneId, path: 'large' })).ok).toBe(true)
    await writeFile(join(f.root, 'large'), 'x'.repeat(FILE_LIMITS.textBytes + 1))
    expect(await feature.call('files.read', { laneId: f.laneId, path: 'large' })).toEqual(
      code('too-large'),
    )
    await writeFile(join(f.root, 'large'), Buffer.alloc(FILE_LIMITS.textBytes + 1))
    expect(await feature.call('files.read', { laneId: f.laneId, path: 'large' })).toEqual({
      ok: true,
      data: { binary: true, size: FILE_LIMITS.textBytes + 1, revision: expect.any(String) },
    })
  })
  it('rejects traversal, absolute, metadata, directories and symlink escapes', async () => {
    await writeFile(join(f.base, 'outside'), 'secret')
    await symlink(join(f.base, 'outside'), join(f.root, 'escape'))
    await symlink(f.base, join(f.root, 'parent'))
    await symlink(join(f.root, '.git'), join(f.root, 'metadata'))
    const feature = createFilesFeature(f.context)
    for (const path of [
      '../outside',
      '/etc/passwd',
      'a/../tracked',
      'tracked\0',
      '.git/config',
      'escape',
      'parent/outside',
      'metadata/config',
      '.git',
      '',
    ]) {
      expect(await feature.call('files.read', { laneId: f.laneId, path })).toEqual(
        code('bad-request'),
      )
    }
    await mkdir(join(f.root, 'directory'))
    vi.mocked(fs.open).mockClear()
    expect(await feature.call('files.read', { laneId: f.laneId, path: 'directory' })).toEqual(
      code('bad-request'),
    )
    expect(fs.open).not.toHaveBeenCalled()
    await expect(checkedPath(f.root, 'parent/missing', true)).rejects.toThrow()
    expect(inside(f.root, f.root + '-sibling')).toBe(false)
  })
  it('rejects removed, unknown, inactive and escaped lane roots', async () => {
    const feature = createFilesFeature(f.context)
    f.lane.removedAt = 'removed'
    expect(await feature.call('files.list', { laneId: f.laneId })).toEqual(code('unknown-lane'))
    f.lane.removedAt = null
    vi.mocked(f.context.store.getLane).mockReturnValueOnce(null)
    expect(await feature.call('files.list', { laneId: f.laneId })).toEqual(code('unknown-lane'))
    f.lane.cwd = f.base
    await expect(laneRoot(f.context, f.laneId)).rejects.toThrow('unknown-lane')
    f.lane.cwd = join(f.root, '.git')
    await expect(laneRoot(f.context, f.laneId)).rejects.toThrow('unknown-lane')
    f.lane.cwd = f.root
    vi.mocked(f.context.store.listRepositories).mockReturnValue([])
    expect(await feature.call('files.list', { laneId: f.laneId })).toEqual(code('unknown-lane'))
  })
  it('uses no-follow and nonblocking opens', async () => {
    const feature = createFilesFeature(f.context)
    expect((await feature.call('files.read', { laneId: f.laneId, path: 'tracked' })).ok).toBe(true)
    const flags = vi.mocked(fs.open).mock.calls.at(-1)?.[1]
    expect(typeof flags).toBe('number')
    if (typeof flags !== 'number') throw new Error('Expected numeric flags')
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
  })
  it.each(['dev', 'ino', 'regular'] as const)(
    'checks opened %s before further path operations',
    async (field) => {
      const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
      vi.mocked(fs.lstat).mockClear()
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args)
        const originalStat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          const stats = await originalStat()
          if (field === 'regular') stats.isFile = () => false
          else stats[field] += 1
          return stats
        })
        return handle
      })
      expect(
        await createFilesFeature(f.context).call('files.read', {
          laneId: f.laneId,
          path: 'tracked',
        }),
      ).toEqual(code('bad-request'))
      expect(vi.mocked(fs.lstat).mock.calls).toHaveLength(1)
    },
  )
  it('rechecks path identity after opening', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      await fs.rename(join(f.root, 'tracked'), join(f.root, 'old'))
      await writeFile(join(f.root, 'tracked'), 'replacement')
      return handle
    })
    expect(
      await createFilesFeature(f.context).call('files.read', { laneId: f.laneId, path: 'tracked' }),
    ).toEqual(code('bad-request'))
  })
  it('fails closed on invalid params and never returns tool errors', async () => {
    const feature = createFilesFeature(f.context)
    expect(await feature.call('files.read', { laneId: 'invalid', path: 'tracked' })).toEqual(
      code('bad-request'),
    )
    expect(await feature.call('files.list', { laneId: f.laneId, extra: true })).toEqual(
      code('bad-request'),
    )
    await rm(join(f.root, '.git'), { recursive: true })
    expect(await feature.call('files.list', { laneId: f.laneId })).toEqual({
      ok: true,
      data: { files: ['tracked'] },
    })
    expect(JSON.stringify(vi.mocked(f.context.log).mock.calls)).not.toContain(f.root)
  })
})
