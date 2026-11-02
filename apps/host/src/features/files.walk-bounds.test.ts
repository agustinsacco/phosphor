import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FeatureContext } from './feature'
import type { StoredLane } from '../lanes/store'
import { createFilesFeature } from './files'
import type * as Files from '@phosphor/shared/host-protocol-files'
import { walkFiles } from '@phosphor/session-runtime/files/walk'
import type * as Walk from '@phosphor/session-runtime/files/walk'

// Three files a list: the walk's bounds are then small enough to reach in a test.
vi.mock('@phosphor/shared/host-protocol-files', async (original) => {
  const actual = await original<typeof Files>()
  return { ...actual, FILE_LIMITS: { ...actual.FILE_LIMITS, entries: 3 } }
})
// The real walk, unless a test hands the Host a path the walk would not list.
vi.mock('@phosphor/session-runtime/files/walk', async (original) => {
  const actual = await original<typeof Walk>()
  return { ...actual, walkFiles: vi.fn(actual.walkFiles) }
})

let base: string
let root: string
let list: () => ReturnType<ReturnType<typeof createFilesFeature>['call']>
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'host-walk-bounds-'))
  root = join(base, 'folder')
  await mkdir(root)
  const lane = {
    laneId: randomUUID(),
    repositoryId: '1234567890abcdef',
    cwd: root,
    removedAt: null,
  } as StoredLane
  const context: FeatureContext = {
    store: {
      getLane: vi.fn(() => lane),
      listRepositories: vi.fn(() => [{ id: lane.repositoryId, name: 'folder', path: root }]),
    },
    env: process.env,
    home: base,
    log: vi.fn(),
  }
  list = () => createFilesFeature(context).call('files.list', { laneId: lane.laneId })
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

it('stops a walk through many folders, not only one that finds many files', async () => {
  // 40 nested folders hold one file: the walk reads far more entries than it lists.
  const deep = join(root, ...Array.from({ length: 40 }, () => 'a'))
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, 'file.txt'), 'x')
  expect(await list()).toEqual({ ok: true, data: { files: [] } })
})

it('refuses a walked path through a link, as it refuses one git lists', async () => {
  // A folder swapped for a link between the walk and the check.
  await mkdir(join(base, 'outside'))
  await writeFile(join(base, 'outside', 'secret.txt'), 'x')
  await symlink(join(base, 'outside'), join(root, 'swapped'))
  vi.mocked(walkFiles).mockResolvedValueOnce({ files: ['swapped/secret.txt'], truncated: false })
  expect(await list()).toMatchObject({ ok: false, error: { code: 'bad-request' } })
})
