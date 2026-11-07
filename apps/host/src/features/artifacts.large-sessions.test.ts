import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as indexer from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import type { StoredLane } from '../lanes/store'
import { createArtifactsFeature } from './artifacts'

/**
 * A long lane's session outgrows the per-call scan cap. It must keep listing
 * (its saved index resumes), and a lane that cannot be scanned must not blank
 * every other lane's artifacts on the same Host.
 */
const small = '11111111-1111-4111-8111-111111111111'
const large = '33333333-3333-4333-8333-333333333333'
const padding = ' '.repeat(64 * 1024 - 1) + '\n'

function lines(sessionId: string, slug: string): string {
  const entries = [
    { type: 'session', id: sessionId, cwd: '/host/private' },
    {
      type: 'message',
      id: '1',
      parentId: null,
      timestamp: '2026-10-01T00:00:00Z',
      message: {
        role: 'toolResult',
        toolName: 'artifact_create',
        toolCallId: `call-${slug}`,
        details: { id: slug, version: 1, title: slug, type: 'html', content: `<p>${slug}</p>` },
      },
    },
  ]
  return entries.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function padTo(bytes: number): string {
  return padding.repeat(Math.ceil(bytes / padding.length))
}

describe('Host artifacts on sessions past the scan cap', () => {
  let dir: string
  let lanes: StoredLane[]
  let log: ReturnType<
    typeof vi.fn<(event: string, fields: Record<string, string | number>) => void>
  >
  let feature: ReturnType<typeof createArtifactsFeature>

  function lane(laneId: string, sessionFile: string): StoredLane {
    return {
      laneId,
      repositoryId: '1234567890abcdef',
      cwd: dir,
      worktree: false,
      sessionFile,
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
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-artifacts-large-'))
    lanes = []
    log = vi.fn<(event: string, fields: Record<string, string | number>) => void>()
    feature = createArtifactsFeature({
      store: {
        getLane: (id) => lanes.find((l) => l.laneId === id) ?? null,
        listLanes: () => lanes,
        listRepositories: () => [],
      },
      env: { XDG_STATE_HOME: dir },
      home: dir,
      log,
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('resumes a saved index, so a session that grew past the cap still lists and reads', async () => {
    const id = '44444444-4444-4444-8444-444444444444'
    const file = join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`)
    await writeFile(file, lines(id, 'map') + padTo(ARTIFACT_LIMITS.sessionBytes * 0.6))
    lanes = [lane(small, file)]
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: true,
      data: [{ laneId: small, slug: 'map' }],
    })
    await appendFile(file, padTo(ARTIFACT_LIMITS.sessionBytes * 0.6))
    const scan = vi.spyOn(indexer, 'indexSessionFile')
    expect(await feature.call('artifacts.list', { laneId: small })).toMatchObject({
      ok: true,
      data: [{ laneId: small, slug: 'map' }],
    })
    expect(await feature.call('artifacts.read', { laneId: small, slug: 'map' })).toEqual({
      ok: true,
      data: { version: 1, content: '<p>map</p>' },
    })
    expect(scan.mock.calls.every(([, , previous]) => previous !== null)).toBe(true)
  })

  it('skips a lane it cannot scan instead of hiding every other lane', async () => {
    const goodId = '55555555-5555-4555-8555-555555555555'
    const bigId = '66666666-6666-4666-8666-666666666666'
    const good = join(dir, `2026-10-01T00-00-00-000Z_${goodId}.jsonl`)
    const big = join(dir, `2026-10-02T00-00-00-000Z_${bigId}.jsonl`)
    await writeFile(good, lines(goodId, 'kept'))
    await writeFile(big, lines(bigId, 'huge') + padTo(ARTIFACT_LIMITS.sessionBytes + 1))
    lanes = [lane(large, big), lane(small, good)]
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: true,
      data: [{ laneId: small, slug: 'kept' }],
    })
    expect(log).toHaveBeenCalledWith(
      'artifact-lane-skipped',
      expect.objectContaining({ reason: 'too-large' }),
    )
    expect(await feature.call('artifacts.list', { laneId: large })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
  })
})
