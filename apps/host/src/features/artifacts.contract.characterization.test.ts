import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as indexer from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import type { StoredLane } from '../lanes/store'
import { createArtifactsFeature } from './artifacts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const laneId = '11111111-1111-4111-8111-111111111111'
let dir: string
let lane: StoredLane
let feature: ReturnType<typeof createArtifactsFeature>

async function session(slug = 'guide', content = 'é') {
  const entries = [
    { type: 'session', id: laneId, cwd: '/private' },
    ...[1, 2, 3].map((version) => ({
      type: 'message',
      id: String(version),
      parentId: version === 1 ? null : '1',
      timestamp: '2026-10-01T00:00:00Z',
      message: {
        role: 'toolResult',
        toolName: 'artifact_create',
        toolCallId: `call-${version}`,
        details: { id: slug, version, title: 'Guide', type: 'code', language: 'ts', content },
      },
    })),
  ]
  await writeFile(
    lane.sessionFile!,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artifact-contract-'))
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

describe('artifact facade frozen contract', () => {
  it('admits nine calls, rejects the tenth and releases FIFO after scan and validation failures', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scan = vi
      .spyOn(indexer, 'indexSessionFile')
      .mockImplementationOnce(async () => {
        await gate
        throw new Error('session-too-large')
      })
      .mockResolvedValue(null)
    const completed: number[] = []
    const calls = Array.from({ length: 9 }, (_, i) =>
      feature
        .call(
          i === 1 ? 'artifacts.read' : 'artifacts.list',
          i === 1 ? { laneId, slug: 'guide' } : {},
        )
        .then((result) => {
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
    expect(await feature.call('artifacts.list', { path: '/private' })).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    release()
    const results = await Promise.all(calls)
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'too-large' } })
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(results.slice(2)).toEqual(Array.from({ length: 7 }, () => ({ ok: true, data: [] })))
    expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(await feature.call('artifacts.list', {})).toEqual({ ok: true, data: [] })
  })

  it.each([
    ['artifacts.list', {}, { ok: true, data: [] }],
    ['artifacts.list', { laneId }, { ok: false, error: { code: 'unknown-lane' } }],
    ['artifacts.read', { laneId, slug: 'guide' }, { ok: false, error: { code: 'unknown-lane' } }],
  ])('never returns content removed during indexing: %s %j', async (method, params, expected) => {
    const original = indexer.indexSessionFile
    vi.spyOn(indexer, 'indexSessionFile').mockImplementationOnce(async (...args) => {
      const saved = await original(...args)
      lane = { ...lane, removedAt: 'removed' }
      return saved
    })
    expect(await feature.call(method, params)).toMatchObject(expected)
  })

  it('never returns content removed while closing the blob descriptor', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const fd = await actual.open(...args)
      if (String(args[0]).includes('/blobs/')) {
        const close = fd.close.bind(fd)
        vi.spyOn(fd, 'close').mockImplementationOnce(async () => {
          await close()
          lane = { ...lane, removedAt: 'removed' }
        })
      }
      return fd
    })
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'unknown-lane' },
    })
  })

  it('lists only sorted current-branch versions and resolves default and explicit reads', async () => {
    expect(await feature.call('artifacts.list', { laneId })).toEqual({
      ok: true,
      data: [
        {
          laneId,
          slug: 'guide',
          title: 'Guide',
          type: 'code',
          language: 'ts',
          versions: [1, 3].map((version) => ({
            version,
            title: 'Guide',
            createdAt: Date.parse('2026-10-01T00:00:00Z'),
            bytes: 2,
          })),
        },
      ],
    })
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toEqual({
      ok: true,
      data: { version: 3, content: 'é' },
    })
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide', version: 1 })).toEqual({
      ok: true,
      data: { version: 1, content: 'é' },
    })
    expect(
      await feature.call('artifacts.read', { laneId, slug: 'guide', version: 2 }),
    ).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('preserves the inclusive content byte cap and rejects larger content', async () => {
    await session('guide', 'x'.repeat(ARTIFACT_LIMITS.contentBytes))
    expect((await feature.call('artifacts.read', { laneId, slug: 'guide' })).ok).toBe(true)
    await session('guide', 'x'.repeat(ARTIFACT_LIMITS.contentBytes + 1))
    expect(await feature.call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
  })

  it('bounds aggregate serialized UTF8 metadata bytes', async () => {
    const saved = await indexer.indexSessionFile(join(dir, 'artifacts'), lane.sessionFile!, null)
    if (!saved) throw new Error('Missing fixture')
    const artifact = saved.artifacts.guide!
    artifact.versions = Array.from({ length: 1000 }, (_, i) => ({
      ...artifact.versions[0]!,
      version: i + 1,
      title: 'é'.repeat(1000),
    }))
    saved.artifacts = Object.fromEntries(
      [1, 2, 3].map((i) => [`guide-${i}`, { ...artifact, slug: `guide-${i}` }]),
    )
    vi.spyOn(indexer, 'indexSessionFile').mockResolvedValue(saved)
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
  })

  it.each([
    ['constructor', true, true],
    ['toString', false, false],
    ['odd_slug', false, false],
    ['__proto__', true, false],
  ])('preserves unusual slug behavior for %s after D5', async (slug, listOk, readOk) => {
    await session(slug)
    const listed = await feature.call('artifacts.list', {})
    expect(listed.ok).toBe(listOk)
    if (slug === '__proto__') expect(listed).toEqual({ ok: true, data: [] })
    if (!listOk) expect(listed).toMatchObject({ error: { code: 'too-large' } })
    const read = await feature.call('artifacts.read', { laneId, slug })
    expect(read.ok).toBe(readOk)
    if (!readOk) expect(read).toMatchObject({ error: { code: 'bad-request' } })
    if (readOk) expect(read).toEqual({ ok: true, data: { version: 3, content: 'é' } })
  })
})
