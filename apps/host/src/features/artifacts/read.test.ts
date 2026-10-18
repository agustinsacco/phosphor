import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blobFile,
  type SessionArtifactIndex,
} from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import { FeatureFailure } from '../machine'
import * as query from './query'
import { readArtifact } from './read'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const laneId = '11111111-1111-4111-8111-111111111111'
const params = { laneId, slug: 'guide' }
let root: string
let path: string
let saved: SessionArtifactIndex
let ports: query.ArtifactLanePorts

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'artifact-read-'))
  await fs.mkdir(join(root, 'blobs'))
  path = blobFile(root, 'a'.repeat(64))
  await fs.writeFile(path, 'é')
  saved = {
    format: 2,
    sessionId: laneId,
    sessionFile: '/private/session.jsonl',
    cwd: '/private',
    deleted: false,
    scan: { offset: 0, size: 0, mtimeMs: 0, signature: '', leafId: null },
    artifacts: {
      guide: {
        slug: 'guide',
        title: 'Guide',
        type: 'code',
        versions: [3, 2, 1].map((version) => ({
          version,
          toolCallId: 'private-call',
          entryId: String(version),
          sha256: 'a'.repeat(64),
          bytes: 2,
          createdAt: '',
          title: 'Guide',
          onBranch: version !== 2,
        })),
      },
    },
  }
  ports = {
    store: { getLane: vi.fn(() => null), listLanes: vi.fn(() => []) },
    admitted: vi.fn(() => true),
    requireLane: vi.fn(),
  }
  vi.spyOn(query, 'indexArtifacts').mockResolvedValue(saved)
})
afterEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  await fs.rm(root, { recursive: true, force: true })
})

describe('artifact read', () => {
  it('selects the latest on-branch version or an explicit on-branch version', async () => {
    expect(await readArtifact(root, ports, params)).toEqual({
      ok: true,
      data: { version: 3, content: 'é' },
    })
    expect(await readArtifact(root, ports, { ...params, version: 1 })).toEqual({
      ok: true,
      data: { version: 1, content: 'é' },
    })
    await expect(readArtifact(root, ports, { ...params, version: 2 })).rejects.toMatchObject({
      code: 'bad-request',
    })
    await expect(readArtifact(root, ports, { ...params, version: 4 })).rejects.toMatchObject({
      code: 'bad-request',
    })
    expect(saved.artifacts.guide!.versions.map((v) => v.version)).toEqual([3, 2, 1])
  })

  it('rejects incomplete requests, absent indexes and unknown slugs before opening blobs', async () => {
    await expect(readArtifact(root, ports, {})).rejects.toMatchObject({ code: 'bad-request' })
    await expect(readArtifact(root, ports, { ...params, slug: 'missing' })).rejects.toMatchObject({
      code: 'bad-request',
    })
    vi.mocked(query.indexArtifacts).mockResolvedValue(null)
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'bad-request' })
    expect(fs.open).not.toHaveBeenCalled()
  })

  it('rechecks admission after indexing before resolving a blob', async () => {
    vi.mocked(ports.requireLane).mockImplementation(() => {
      throw new FeatureFailure('unknown-lane')
    })
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'unknown-lane' })
    expect(fs.open).not.toHaveBeenCalled()
  })

  it('uses only a validated index hash and opens with no-follow, never a slug path', async () => {
    await readArtifact(root, ports, params)
    expect(fs.open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    saved.artifacts.guide!.versions[0]!.sha256 = '../../outside'
    await expect(readArtifact(root, ports, params)).rejects.toThrow('invalid artifact blob id')
    expect(fs.open).toHaveBeenCalledTimes(1)
  })

  it('refuses symlink blobs even when the target contains valid content', async () => {
    await fs.rename(path, join(root, 'target'))
    await fs.symlink(join(root, 'target'), path)
    await expect(readArtifact(root, ports, params)).rejects.toBeInstanceOf(Error)
  })

  it('rejects indexed content above the cap before opening', async () => {
    saved.artifacts.guide!.versions[0]!.bytes = ARTIFACT_LIMITS.contentBytes + 1
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'too-large' })
    expect(fs.open).not.toHaveBeenCalled()
  })

  it.each([
    ['short', Buffer.from('x')],
    ['long', Buffer.from('abc')],
    ['invalid UTF8', Buffer.from([0xc3, 0x28])],
  ])('rejects %s bytes and closes the descriptor on validation failure', async (_name, bytes) => {
    await fs.writeFile(path, bytes)
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const closed = vi.fn()
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const fd = await actual.open(...args)
      const close = fd.close.bind(fd)
      vi.spyOn(fd, 'close').mockImplementation(async () => {
        await close()
        closed()
      })
      return fd
    })
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'internal' })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(ports.requireLane).toHaveBeenCalledTimes(1)
  })

  it('bounds a descriptor that grows after stat to the original size plus one', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const fd = await actual.open(...args)
      const stat = fd.stat.bind(fd)
      vi.spyOn(fd, 'stat').mockImplementationOnce(async () => {
        const info = await stat()
        await fs.appendFile(path, 'x'.repeat(100))
        return info
      })
      const read = fd.read.bind(fd)
      vi.spyOn(fd, 'read').mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        expect(readArgs[0]).toHaveLength(3)
        return read(...readArgs)
      })
      return fd
    })
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'internal' })
  })

  it.each(['directory', 'oversized'])('closes and rejects a %s descriptor', async (kind) => {
    await fs.rm(path)
    if (kind === 'directory') await fs.mkdir(path)
    else await fs.writeFile(path, 'x'.repeat(ARTIFACT_LIMITS.contentBytes + 1))
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('closes the descriptor before the final admission recheck and returns no removed content', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const fd = await actual.open(...args)
      const close = fd.close.bind(fd)
      vi.spyOn(fd, 'close').mockImplementationOnce(async () => {
        await close()
        vi.mocked(ports.requireLane).mockImplementation(() => {
          throw new FeatureFailure('unknown-lane')
        })
      })
      return fd
    })
    await expect(readArtifact(root, ports, params)).rejects.toMatchObject({ code: 'unknown-lane' })
    expect(ports.requireLane).toHaveBeenCalledTimes(2)
  })
})
