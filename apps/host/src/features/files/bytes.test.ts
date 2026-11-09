import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FILE_BYTES_LIMITS, parseFileBytes } from '@phosphor/shared/host-protocol-file-bytes'
import type { FeatureContext } from '../feature'
import { createFilesFeature } from '../files'

let base: string
let root: string
let context: FeatureContext
const laneId = randomUUID()
let removedAt: string | null = null

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'host-bytes-'))
  root = join(base, 'repo')
  await mkdir(root)
  removedAt = null
  context = {
    store: {
      getLane: vi.fn(() => ({ laneId, repositoryId: '1234567890abcdef', cwd: root, removedAt })),
      listRepositories: vi.fn(() => [{ id: '1234567890abcdef', name: 'repo', path: root }]),
    } as unknown as FeatureContext['store'],
    env: process.env,
    home: base,
    log: vi.fn(),
  }
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const read = (params: Record<string, unknown>) =>
  createFilesFeature(context).call('files.readBytes', { laneId, ...params })
const failed = (code: string) => ({ ok: false, error: { code, message: expect.any(String) } })

describe('files.readBytes', () => {
  it('serves any file in chunks under one version, binary included', async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 3, 4, 5])
    await writeFile(join(root, 'clip.mp4'), bytes)
    const first = await read({ path: 'clip.mp4', offset: 0, length: 4 })
    const rest = await read({ path: 'clip.mp4', offset: 4, length: 4 })
    const end = await read({ path: 'clip.mp4', offset: 7, length: 4 })
    const a = first.ok ? parseFileBytes(first.data, { offset: 0, length: 4 }) : null
    const b = rest.ok ? parseFileBytes(rest.data, { offset: 4, length: 4 }) : null
    const c = end.ok ? parseFileBytes(end.data, { offset: 7, length: 4 }) : null
    expect(a && b && c).toBeTruthy()
    expect(Buffer.concat([a!, b!].map((x) => Buffer.from(x.data, 'base64')))).toEqual(bytes)
    expect(c).toMatchObject({ size: 7, data: '' })
    expect(new Set([a!.version, b!.version, c!.version]).size).toBe(1)
  })

  it('moves the version when the file changes', async () => {
    await writeFile(join(root, 'f'), 'one')
    const before = await read({ path: 'f', offset: 0, length: 1 })
    await appendFile(join(root, 'f'), 'two')
    const after = await read({ path: 'f', offset: 0, length: 1 })
    expect(before.ok && after.ok).toBe(true)
    expect((before as { data: { version: string } }).data.version).not.toBe(
      (after as { data: { version: string } }).data.version,
    )
  })

  it('reads a configured repository by id', async () => {
    await writeFile(join(root, 'f'), 'abc')
    const result = await createFilesFeature(context).call('files.readBytes', {
      repositoryId: '1234567890abcdef',
      path: 'f',
      offset: 1,
      length: 2,
    })
    expect(result).toMatchObject({
      ok: true,
      data: { size: 3, data: Buffer.from('bc').toString('base64') },
    })
  })

  it('refuses a file over the byte limit without reading it', async () => {
    await writeFile(join(root, 'huge'), '')
    await truncate(join(root, 'huge'), FILE_BYTES_LIMITS.fileBytes + 1)
    expect(await read({ path: 'huge', offset: 0, length: 1 })).toEqual(failed('too-large'))
  })

  it('refuses links out, .git, folders, offsets past the end and oversized chunks', async () => {
    await writeFile(join(base, 'secret'), 'x')
    await symlink(join(base, 'secret'), join(root, 'link'))
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'x')
    await mkdir(join(root, 'dir'))
    await writeFile(join(root, 'f'), 'abc')
    expect(await read({ path: 'link', offset: 0, length: 1 })).toEqual(failed('bad-request'))
    expect(await read({ path: '.git/config', offset: 0, length: 1 })).toEqual(failed('bad-request'))
    expect(await read({ path: 'dir', offset: 0, length: 1 })).toEqual(failed('bad-request'))
    expect(await read({ path: 'f', offset: 4, length: 1 })).toEqual(failed('bad-request'))
    expect(await read({ path: 'f', offset: 0, length: FILE_BYTES_LIMITS.chunkBytes + 1 })).toEqual(
      failed('bad-request'),
    )
    expect(await read({ path: 'f', offset: 0, length: 1, extra: 1 })).toEqual(failed('bad-request'))
  })

  it('refuses a missing file and a removed lane', async () => {
    expect(await read({ path: 'gone', offset: 0, length: 1 })).toEqual(failed('internal'))
    await writeFile(join(root, 'f'), 'abc')
    removedAt = new Date().toISOString()
    expect(await read({ path: 'f', offset: 0, length: 1 })).toEqual(failed('unknown-lane'))
  })
})
