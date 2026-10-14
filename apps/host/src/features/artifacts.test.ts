import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as indexer from '@phosphor/session-runtime/artifacts/artifact-indexer'
import * as fs from 'node:fs/promises'
import { blobFile } from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import type { StoredLane } from '../lanes/store'
import { createArtifactsFeature } from './artifacts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const laneId = '11111111-1111-4111-8111-111111111111'
describe('Host artifacts', () => {
  let dir: string
  let lane: StoredLane
  let feature: ReturnType<typeof createArtifactsFeature>
  async function session(content = '<script>hello()</script>') {
    const lines = [
      { type: 'session', id: '22222222-2222-4222-8222-222222222222', cwd: '/host/private' },
      {
        type: 'message',
        id: '1',
        parentId: null,
        timestamp: '2026-10-01T00:00:00Z',
        message: {
          role: 'toolResult',
          toolName: 'artifact_create',
          toolCallId: 'private-call',
          details: { id: 'guide', version: 1, title: 'Guide', type: 'html', content },
        },
      },
      { type: 'compaction', id: '2', parentId: '1' },
    ]
    await writeFile(
      join(dir, 'session.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    )
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-artifacts-'))
    lane = {
      laneId,
      repositoryId: '1234567890abcdef',
      cwd: dir,
      worktree: false,
      sessionFile: join(dir, 'session.jsonl'),
      removedAt: null,
      title: null,
      branch: null,
      model: null,
      activity: 'idle',
      control: { fence: 1, controller: null },
      attention: 0,
      read: 0,
      createdAt: '',
      updatedAt: '',
    }
    feature = createArtifactsFeature({
      store: {
        getLane: (id) => (id === laneId ? lane : null),
        listLanes: () => [lane],
        listRepositories: () => [],
      },
      env: { XDG_STATE_HOME: dir },
      home: dir,
      log: vi.fn(),
    })
    await session()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
    await rm(dir, { recursive: true, force: true })
  })
  it('indexes compacted history on demand and returns metadata without private identities', async () => {
    const result = await feature.call('artifacts.list', {})
    expect(result).toMatchObject({
      ok: true,
      data: [{ laneId, slug: 'guide', versions: [{ version: 1 }] }],
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('22222222')
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toEqual({
      ok: true,
      data: { version: 1, content: '<script>hello()</script>' },
    })
  })
  it('refuses unknown/removed lanes, off-branch versions and client paths', async () => {
    expect(
      await feature.call('artifacts.read', { laneId, slug: 'guide', version: 2 }),
    ).toMatchObject({ ok: false })
    expect(
      await feature.call('artifacts.list', { laneId: '33333333-3333-4333-8333-333333333333' }),
    ).toMatchObject({ ok: false, error: { code: 'unknown-lane' } })
    expect(await feature.call('artifacts.list', { sessionFile: lane.sessionFile })).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    lane = { ...lane, removedAt: 'removed' }
    expect(await feature.call('artifacts.list', {})).toEqual({ ok: true, data: [] })
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'unknown-lane' },
    })
  })
  it('bounds version content at and above 2 MiB and session scans', async () => {
    await session('x'.repeat(ARTIFACT_LIMITS.contentBytes))
    expect((await feature.call('artifacts.read', { laneId, slug: 'guide' })).ok).toBe(true)
    await session('x'.repeat(ARTIFACT_LIMITS.contentBytes + 1))
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
    // Short lines avoid quadratic buffering of a single 32 MiB unfinished line.
    const line = ' '.repeat(64 * 1024 - 1) + '\n'
    await writeFile(
      join(dir, 'session.jsonl'),
      line.repeat(ARTIFACT_LIMITS.sessionBytes / line.length),
    )
    expect(await feature.call('artifacts.list', {})).toEqual({ ok: true, data: [] })
    await appendFile(join(dir, 'session.jsonl'), ' ')
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
  })
  it('serializes one active call and eight FIFO waiters, rejecting the next', async () => {
    const original = indexer.indexSessionFile
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scan = vi.spyOn(indexer, 'indexSessionFile').mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
    const completed: number[] = []
    const calls = Array.from({ length: 9 }, (_, i) =>
      feature.call('artifacts.list', {}).then((result) => {
        completed.push(i)
        return result
      }),
    )
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    release()
    expect((await Promise.all(calls)).every((result) => result.ok)).toBe(true)
    expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect((await feature.call('artifacts.list', {})).ok).toBe(true)
  })
  it.each([
    ['artifacts.list', {}, { ok: true, data: [] }],
    ['artifacts.list', { laneId }, { ok: false, error: { code: 'unknown-lane' } }],
    ['artifacts.read', { laneId, slug: 'guide' }, { ok: false, error: { code: 'unknown-lane' } }],
  ])('rechecks lane removal during indexing for %s %j', async (method, params, expected) => {
    const original = indexer.indexSessionFile
    vi.spyOn(indexer, 'indexSessionFile').mockImplementationOnce(async (...args) => {
      const saved = await original(...args)
      lane = { ...lane, removedAt: 'removed' }
      return saved
    })
    expect(await feature.call(method, params)).toMatchObject(expected)
  })
  it('drops an earlier lane removed while indexing a later lane', async () => {
    const second = { ...lane, laneId: '33333333-3333-4333-8333-333333333333' }
    feature = createArtifactsFeature({
      store: {
        getLane: (id) => (id === laneId ? lane : id === second.laneId ? second : null),
        listLanes: () => [lane, second],
        listRepositories: () => [],
      },
      env: { XDG_STATE_HOME: dir },
      home: dir,
      log: vi.fn(),
    })
    const original = indexer.indexSessionFile
    let scans = 0
    vi.spyOn(indexer, 'indexSessionFile').mockImplementation(async (...args) => {
      const saved = await original(...args)
      if (++scans === 2) lane = { ...lane, removedAt: 'removed' }
      return saved
    })
    const result = await feature.call('artifacts.list', {})
    expect(result).toMatchObject({ ok: true, data: [{ laneId: second.laneId }] })
    expect(JSON.stringify(result)).not.toContain(laneId)
  })
  it('rechecks removal after the final blob await', async () => {
    const original = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const fd = await original.open(...args)
      if (!String(args[0]).includes('/blobs/')) return fd
      const close = fd.close.bind(fd)
      vi.spyOn(fd, 'close').mockImplementationOnce(async () => {
        await close()
        lane = { ...lane, removedAt: 'removed' }
      })
      return fd
    })
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'unknown-lane' },
    })
  })
  it('excludes branch-jumped versions from lists, latest reads and explicit reads', async () => {
    await appendFile(
      join(dir, 'session.jsonl'),
      [
        {
          type: 'message',
          id: '3',
          parentId: '2',
          message: {
            role: 'toolResult',
            toolName: 'artifact_update',
            toolCallId: 'off-branch',
            details: {
              id: 'guide',
              version: 2,
              title: 'Guide',
              type: 'html',
              content: 'off branch',
            },
          },
        },
        {
          type: 'message',
          id: '4',
          parentId: '1',
          message: { role: 'user', content: 'branch jump' },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    )
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: true,
      data: [{ versions: [{ version: 1 }] }],
    })
    const listed = await feature.call('artifacts.list', {})
    expect(JSON.stringify(listed)).not.toContain('"version":2')
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toEqual({
      ok: true,
      data: { version: 1, content: '<script>hello()</script>' },
    })
    expect(
      await feature.call('artifacts.read', { laneId, slug: 'guide', version: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  })
  it('rejects oversized indexed bytes before opening a missing blob', async () => {
    const root = join(dir, 'phosphor-host', 'artifacts')
    const saved = await indexer.indexSessionFile(root, join(dir, 'session.jsonl'), null)
    const version = saved?.artifacts.guide?.versions[0]
    if (!saved || !version) throw new Error('Missing fixture version')
    await rm(blobFile(root, version.sha256))
    version.bytes = ARTIFACT_LIMITS.contentBytes + 1
    vi.spyOn(indexer, 'indexSessionFile').mockResolvedValueOnce(saved)
    const open = vi.mocked(fs.open)
    open.mockClear()
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
    expect(open).not.toHaveBeenCalled()
  })
})
