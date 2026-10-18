import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as indexer from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import type { StoredLane } from '../../lanes/store'
import { FeatureFailure } from '../machine'
import { indexArtifacts, listArtifacts, type ArtifactLanePorts } from './query'

const laneId = '11111111-1111-4111-8111-111111111111'
let lane: StoredLane
let saved: indexer.SessionArtifactIndex
let ports: ArtifactLanePorts

beforeEach(() => {
  lane = {
    laneId,
    repositoryId: 'repository',
    cwd: '/private',
    worktree: false,
    sessionFile: '/private/session.jsonl',
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
  saved = {
    format: 2,
    sessionId: laneId,
    sessionFile: lane.sessionFile!,
    cwd: lane.cwd,
    deleted: false,
    scan: { offset: 0, size: 0, mtimeMs: 0, signature: '', leafId: null },
    artifacts: {
      guide: {
        slug: 'guide',
        title: 'Guide',
        type: 'code',
        language: 'ts',
        versions: [3, 2, 1].map((version) => ({
          version,
          toolCallId: 'private-call',
          entryId: String(version),
          sha256: 'a'.repeat(64),
          bytes: 2,
          createdAt: version === 1 ? 'invalid' : '2026-10-01T00:00:00Z',
          title: 'Guide',
          onBranch: version !== 2,
        })),
      },
    },
  }
  ports = {
    store: {
      getLane: vi.fn((id) => (id === laneId ? lane : null)),
      listLanes: vi.fn(() => [lane]),
    },
    admitted: vi.fn(() => lane.removedAt === null),
    requireLane: vi.fn(() => {
      if (lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
    }),
  }
  vi.spyOn(indexer, 'indexSessionFile').mockResolvedValue(saved)
  vi.spyOn(indexer, 'writeIndex').mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('artifact query', () => {
  it('admits only present live lanes and skips unpersisted sessions', async () => {
    await expect(indexArtifacts('/root', ports.store, 'missing')).rejects.toMatchObject({
      code: 'unknown-lane',
    })
    lane = { ...lane, removedAt: 'removed' }
    await expect(indexArtifacts('/root', ports.store, laneId)).rejects.toMatchObject({
      code: 'unknown-lane',
    })
    lane = { ...lane, removedAt: null }
    lane = { ...lane, sessionFile: null }
    expect(await indexArtifacts('/root', ports.store, laneId)).toBeNull()
    expect(indexer.indexSessionFile).not.toHaveBeenCalled()
  })

  it('indexes with the session byte limit and persists only a non-null index', async () => {
    expect(await indexArtifacts('/root', ports.store, laneId)).toBe(saved)
    expect(indexer.indexSessionFile).toHaveBeenCalledWith(
      '/root',
      lane.sessionFile,
      null,
      ARTIFACT_LIMITS.sessionBytes,
    )
    expect(indexer.writeIndex).toHaveBeenCalledWith('/root', saved)
    vi.mocked(indexer.indexSessionFile).mockResolvedValueOnce(null)
    expect(await indexArtifacts('/root', ports.store, laneId)).toBeNull()
    expect(indexer.writeIndex).toHaveBeenCalledTimes(1)
  })

  it('constructs public sorted branch metadata, normalizes dates and omits empty languages', async () => {
    saved.artifacts.guide!.language = ''
    expect(await listArtifacts('/root', ports, laneId)).toEqual({
      ok: true,
      data: [
        {
          laneId,
          slug: 'guide',
          title: 'Guide',
          type: 'code',
          versions: [1, 3].map((version) => ({
            version,
            title: 'Guide',
            createdAt: version === 1 ? 0 : Date.parse('2026-10-01T00:00:00Z'),
            bytes: 2,
          })),
        },
      ],
    })
    expect(ports.requireLane).toHaveBeenCalledWith(laneId)
    expect(saved.artifacts.guide!.versions.map((v) => v.version)).toEqual([3, 2, 1])
    saved.artifacts.guide!.versions.forEach((v) => {
      v.onBranch = false
    })
    expect(await listArtifacts('/root', ports)).toEqual({ ok: true, data: [] })
  })

  it('skips removed lanes and rechecks admission after the final await', async () => {
    lane = { ...lane, removedAt: 'removed' }
    expect(await listArtifacts('/root', ports)).toEqual({ ok: true, data: [] })
    expect(indexer.indexSessionFile).not.toHaveBeenCalled()
    lane = { ...lane, removedAt: null }
    vi.mocked(indexer.writeIndex).mockImplementation(async () => {
      lane = { ...lane, removedAt: 'removed' }
    })
    expect(await listArtifacts('/root', ports)).toEqual({ ok: true, data: [] })
    await expect(listArtifacts('/root', ports, laneId)).rejects.toMatchObject({
      code: 'unknown-lane',
    })
  })

  it('rejects excessive lane counts before scanning', async () => {
    vi.mocked(ports.store.listLanes).mockReturnValue(
      Array.from({ length: ARTIFACT_LIMITS.count + 1 }, () => lane),
    )
    await expect(listArtifacts('/root', ports)).rejects.toMatchObject({ code: 'too-large' })
    expect(indexer.indexSessionFile).not.toHaveBeenCalled()
  })

  it('rejects excessive item counts and invalid version metadata', async () => {
    const artifact = saved.artifacts.guide!
    saved.artifacts = Object.fromEntries(
      Array.from({ length: ARTIFACT_LIMITS.count + 1 }, (_, i) => [
        `guide-${i}`,
        { ...artifact, slug: `guide-${i}` },
      ]),
    )
    await expect(listArtifacts('/root', ports)).rejects.toMatchObject({ code: 'too-large' })
    saved.artifacts = { guide: artifact }
    artifact.versions[0]!.bytes = ARTIFACT_LIMITS.contentBytes + 1
    await expect(listArtifacts('/root', ports)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('counts serialized UTF8 metadata rather than characters', async () => {
    const artifact = saved.artifacts.guide!
    artifact.versions = Array.from({ length: 1000 }, (_, i) => ({
      ...artifact.versions[0]!,
      version: i + 1,
      title: 'é'.repeat(1000),
    }))
    saved.artifacts = Object.fromEntries(
      [1, 2, 3].map((i) => [`guide-${i}`, { ...artifact, slug: `guide-${i}` }]),
    )
    const result = await listArtifacts('/root', ports).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: 'too-large' })
    artifact.versions.forEach((v) => {
      v.title = 'x'.repeat(1000)
    })
    expect((await listArtifacts('/root', ports)).ok).toBe(true)
  })
})
