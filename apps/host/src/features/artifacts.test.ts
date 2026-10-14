import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARTIFACT_LIMITS } from '@phosphor/shared/host-protocol-artifacts'
import type { StoredLane } from '../lanes/store'
import { createArtifactsFeature } from './artifacts'

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
    await writeFile(join(dir, 'session.jsonl'), ' '.repeat(ARTIFACT_LIMITS.sessionBytes))
    expect(await feature.call('artifacts.list', {})).toEqual({ ok: true, data: [] })
    await writeFile(join(dir, 'session.jsonl'), ' '.repeat(ARTIFACT_LIMITS.sessionBytes + 1))
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    })
  })
  it('does not queue concurrent indexing calls', async () => {
    const first = feature.call('artifacts.list', {})
    expect(await feature.call('artifacts.list', {})).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    await first
  })
})
