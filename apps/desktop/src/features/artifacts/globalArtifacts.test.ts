import { describe, expect, it } from 'vitest'
import type { ArtifactListing } from '@shared/artifacts'
import type { Artifact } from '@/stores/artifacts'
import { mergeGlobalArtifacts, canViewStoredArtifact } from './globalArtifacts'

const stored = (over: Partial<ArtifactListing> = {}): ArtifactListing => ({
  key: 'sid/guide',
  sessionId: 'sid',
  id: 'guide',
  sessionFile: '/sessions/a.jsonl',
  cwd: '/work',
  sessionName: 'Remote access',
  title: 'Guide',
  type: 'html',
  version: 2,
  versionCount: 2,
  updatedAt: 100,
  revision: 'call-2',
  sessionDeleted: false,
  workspaceExists: true,
  ...over,
})

const liveArtifact = (version: number, updatedAt: number): Artifact => ({
  id: 'guide',
  title: `Guide v${version}`,
  type: 'html',
  versions: Array.from({ length: version }, (_, i) => ({
    version: i + 1,
    title: 'Guide',
    content: '',
    createdAt: 0,
  })),
  updatedAt,
})

describe('mergeGlobalArtifacts', () => {
  it('lists closed and deleted sessions’ artifacts straight from the store', () => {
    const rows = mergeGlobalArtifacts([stored({ sessionDeleted: true })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'sid/guide', sessionDeleted: true })
    expect(rows[0]!.phosphorId).toBeUndefined()
  })

  it('marks a stored row whose session is open, so it opens in place', () => {
    const rows = mergeGlobalArtifacts(
      [stored()],
      [{ phosphorId: 'p1', diskPath: '/sessions/a.jsonl', workspacePath: '/work', artifacts: {} }],
    )
    expect(rows[0]!.phosphorId).toBe('p1')
  })

  it('lays a running turn’s newer version over the stored one', () => {
    const rows = mergeGlobalArtifacts(
      [stored()],
      [
        {
          phosphorId: 'p1',
          diskPath: '/sessions/a.jsonl',
          workspacePath: '/work',
          artifacts: { guide: liveArtifact(3, 500) },
        },
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'sid/guide',
      version: 3,
      updatedAt: 500,
      title: 'Guide v3',
    })
    // Still knows which session it came from.
    expect(rows[0]!.sessionName).toBe('Remote access')
  })

  it('includes a brand-new session that has no file yet', () => {
    const rows = mergeGlobalArtifacts(
      [],
      [{ phosphorId: 'p2', workspacePath: '/work', artifacts: { guide: liveArtifact(1, 50) } }],
    )
    expect(rows[0]).toMatchObject({ key: 'live:p2/guide', phosphorId: 'p2', cwd: '/work' })
  })

  it('sorts newest first', () => {
    const rows = mergeGlobalArtifacts(
      [stored({ key: 'a', id: 'a', updatedAt: 1 }), stored({ key: 'b', id: 'b', updatedAt: 9 })],
      [],
    )
    expect(rows.map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('folds forks that still share a version into the open, live, newest session', () => {
    const fork = (key: string, file: string, over: Partial<ArtifactListing> = {}) =>
      stored({ key, sessionFile: `/sessions/${file}.jsonl`, ...over })
    const rows = mergeGlobalArtifacts(
      [
        fork('deleted', '2026-10-03T00-00-00-000Z_d', { sessionDeleted: true }),
        fork('newest', '2026-10-02T00-00-00-000Z_n'),
        fork('open', '2026-10-01T00-00-00-000Z_o'),
        fork('changed', '2026-10-04T00-00-00-000Z_c', {
          revision: 'call-9',
          version: 3,
          updatedAt: 200,
        }),
      ],
      [
        {
          phosphorId: 'p1',
          diskPath: '/sessions/2026-10-01T00-00-00-000Z_o.jsonl',
          workspacePath: '/work',
          artifacts: { guide: liveArtifact(2, 100) },
        },
      ],
    )
    expect(rows.map((r) => [r.key, r.copies, r.phosphorId])).toEqual([
      ['changed', 0, undefined],
      ['open', 2, 'p1'],
    ])
  })

  it('prefers a session that still exists when none of the forks is open', () => {
    const rows = mergeGlobalArtifacts(
      [
        stored({ key: 'gone', sessionFile: '/s/2026-10-09_g.jsonl', sessionDeleted: true }),
        stored({ key: 'kept', sessionFile: '/s/2026-10-01_k.jsonl' }),
      ],
      [],
    )
    expect(rows.map((r) => [r.key, r.copies])).toEqual([['kept', 1]])
  })

  it('never folds a version the session file does not have yet', () => {
    const rows = mergeGlobalArtifacts(
      [
        stored({ key: 'a', sessionFile: '/s/a.jsonl' }),
        stored({ key: 'b', sessionFile: '/s/b.jsonl' }),
      ],
      [
        {
          phosphorId: 'p1',
          diskPath: '/s/a.jsonl',
          workspacePath: '/work',
          artifacts: { guide: liveArtifact(3, 500) },
        },
      ],
    )
    expect(rows.map((r) => [r.key, r.version, r.copies])).toEqual([
      ['a', 3, 0],
      ['b', 2, 0],
    ])
  })
})

it('merges an open remote lane into its opaque library row without losing the machine tag', () => {
  const session =
    'host:22222222-2222-4222-8222-222222222222/lane:11111111-1111-4111-8111-111111111111'
  const key = `${session}/artifact:guide`
  const rows = mergeGlobalArtifacts(
    [
      stored({
        key,
        sessionId: session,
        sessionFile: session,
        cwd: session,
        workspaceExists: false,
        machine: 'bee',
      }),
    ],
    [
      {
        phosphorId: 'remote-1234567890abcdef',
        diskPath: session,
        workspacePath: session,
        artifacts: { guide: liveArtifact(3, 200) },
      },
    ],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    key,
    machine: 'bee',
    phosphorId: 'remote-1234567890abcdef',
    version: 3,
  })
})

it('hides remote library rows and open viewers when ready artifact capability is absent', () => {
  const key = 'host:bee/lane:opaque/artifact:guide'
  const view = { state: 'ready' as const, capabilities: [], lanes: [], repositories: [] }
  expect(canViewStoredArtifact('local/guide', {})).toBe(true)
  expect(canViewStoredArtifact(key, {})).toBe(false)
  expect(canViewStoredArtifact(key, { bee: view })).toBe(false)
  expect(canViewStoredArtifact(key, { bee: { ...view, capabilities: ['artifacts.read'] } })).toBe(
    true,
  )
  expect(
    canViewStoredArtifact(key, {
      bee: { ...view, state: 'reconnecting', capabilities: ['artifacts.read'] },
    }),
  ).toBe(false)
})
