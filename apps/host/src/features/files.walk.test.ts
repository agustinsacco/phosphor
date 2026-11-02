import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import type { FeatureContext } from './feature'
import type { StoredLane } from '../lanes/store'
import { createFilesFeature } from './files'

/** A configured folder that is not a git repository. */
async function folder() {
  const base = await mkdtemp(join(tmpdir(), 'host-walk-'))
  const root = join(base, 'folder')
  await mkdir(root)
  const lane: StoredLane = {
    laneId: randomUUID(),
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
      listRepositories: vi.fn(() => [{ id: lane.repositoryId, name: 'folder', path: root }]),
    },
    env: process.env,
    home: base,
    log: vi.fn(),
  }
  const list = () => createFilesFeature(context).call('files.list', { laneId: lane.laneId })
  return { base, root, list }
}

async function put(root: string, path: string, content = 'x'): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

describe('files.list in a folder without git', () => {
  let f: Awaited<ReturnType<typeof folder>>
  beforeEach(async () => {
    f = await folder()
  })
  afterEach(async () => {
    await chmod(join(f.root, 'locked'), 0o755).catch(() => {})
    await rm(f.base, { recursive: true, force: true })
  })

  it('skips dependency, build and cache folders and hidden folders, as Desktop does', async () => {
    for (const path of [
      'README.md',
      'app/page.tsx',
      'app/.env.example',
      'node_modules/react/index.js',
      'app/node_modules/left-pad/index.js',
      '.next/server/page.js',
      'dist/bundle.js',
      'build/out.js',
      'target/debug/app',
      '__pycache__/x.pyc',
      '.venv/bin/python',
      '.cache/blob',
      '.vscode/settings.json',
      'clone/.git/HEAD',
      'clone/src/main.ts',
    ])
      await put(f.root, path)
    expect(await f.list()).toEqual({
      ok: true,
      data: { files: ['README.md', 'app/.env.example', 'app/page.tsx', 'clone/src/main.ts'] },
    })
  })

  it('lists the first 20,000 files instead of failing above the cap', async () => {
    await mkdir(join(f.root, 'many'))
    const names = Array.from({ length: FILE_LIMITS.entries + 5 }, (_, i) => `many/f${i}`)
    for (let i = 0; i < names.length; i += 1_000)
      await Promise.all(names.slice(i, i + 1_000).map((name) => writeFile(join(f.root, name), '')))
    const result = await f.list()
    expect(result.ok).toBe(true)
    const files = result.ok ? (result.data as { files: string[] }).files : []
    expect(files).toHaveLength(FILE_LIMITS.entries)
    expect(new Set(files).size).toBe(FILE_LIMITS.entries)
  }, 60_000)

  it('leaves out symlinks, including ones that point outside the folder', async () => {
    await put(f.root, 'kept.txt')
    await writeFile(join(f.base, 'outside'), 'secret')
    await symlink(join(f.base, 'outside'), join(f.root, 'escape'))
    await symlink(f.base, join(f.root, 'escape-dir'))
    await symlink(join(f.root, 'kept.txt'), join(f.root, 'alias.txt'))
    expect(await f.list()).toEqual({ ok: true, data: { files: ['kept.txt'] } })
  })

  it.skipIf(process.getuid?.() === 0)('leaves out a folder it cannot read', async () => {
    await put(f.root, 'kept.txt')
    await put(f.root, 'locked/hidden.txt')
    await chmod(join(f.root, 'locked'), 0)
    expect(await f.list()).toEqual({ ok: true, data: { files: ['kept.txt'] } })
  })

  it.skipIf(process.getuid?.() === 0)('fails a folder it cannot read at all', async () => {
    await put(f.root, 'kept.txt')
    await chmod(f.root, 0o300)
    try {
      expect(await f.list()).toEqual({
        ok: false,
        error: { code: 'internal', message: 'File query failed.' },
      })
    } finally {
      await chmod(f.root, 0o755)
    }
  })

  it('leaves out names a file path cannot carry instead of failing the list', async () => {
    await put(f.root, 'kept.txt')
    await put(f.root, 'back\\slash.txt')
    await put(f.root, 'c:notes.txt')
    expect(await f.list()).toEqual({ ok: true, data: { files: ['kept.txt'] } })
  })
})
