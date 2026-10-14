import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_LIMITS,
  parseArtifactParams,
  parseArtifactList,
  parseArtifactRead,
} from './host-protocol-artifacts'
const laneId = '11111111-1111-4111-8111-111111111111'
const item = {
  laneId,
  slug: 'guide',
  title: 'Guide',
  type: 'html',
  versions: [{ version: 1, title: 'Guide', bytes: 2, createdAt: 0 }],
}
describe('artifact protocol', () => {
  it('accepts only exact methods and bounded lane/slug/version params', () => {
    expect(parseArtifactParams('artifacts.list', {})).toEqual({})
    expect(
      parseArtifactParams('artifacts.read', { laneId, slug: 'guide', version: 1 }),
    ).not.toBeNull()
    for (const params of [
      { laneId, slug: '../secret' },
      { laneId, slug: 'x', version: 0 },
      { laneId, slug: 'x', path: '/secret' },
      { slug: 'x' },
      { laneId: 'bad', slug: 'x' },
    ])
      expect(parseArtifactParams('artifacts.read', params)).toBeNull()
    expect(parseArtifactParams('artifacts.list', { sessionFile: '/secret' })).toBeNull()
    expect(parseArtifactParams('unknown', {})).toBeNull()
  })
  it('bounds content in UTF-8 bytes at and above the limit and rejects extra fields', () => {
    const content = 'é'.repeat(ARTIFACT_LIMITS.contentBytes / 2)
    expect(parseArtifactRead({ version: 1, content })).not.toBeNull()
    expect(parseArtifactRead({ version: 1, content: content + 'x' })).toBeNull()
    expect(parseArtifactRead({ version: 1, content: '', path: '/secret' })).toBeNull()
  })
  it('bounds metadata and rejects paths, duplicates and unordered versions', () => {
    expect(parseArtifactList([item])).toEqual([item])
    expect(parseArtifactList([{ ...item, sessionFile: '/secret' }])).toBeNull()
    expect(parseArtifactList([item, item])).toBeNull()
    expect(
      parseArtifactList([{ ...item, versions: [item.versions[0], item.versions[0]] }]),
    ).toBeNull()
    expect(
      parseArtifactList([
        {
          ...item,
          versions: Array.from({ length: ARTIFACT_LIMITS.versions }, (_, i) => ({
            version: i + 1,
            title: '',
            bytes: 0,
            createdAt: 0,
          })),
        },
      ]),
    ).not.toBeNull()
    expect(
      parseArtifactList([
        {
          ...item,
          versions: Array.from({ length: ARTIFACT_LIMITS.versions + 1 }, (_, i) => ({
            version: i + 1,
            title: '',
            bytes: 0,
            createdAt: 0,
          })),
        },
      ]),
    ).toBeNull()
    const items = Array.from({ length: ARTIFACT_LIMITS.count }, (_, i) => ({
      ...item,
      slug: `a-${i}`,
    }))
    expect(parseArtifactList(items)).not.toBeNull()
    expect(parseArtifactList([...items, { ...item, slug: 'last' }])).toBeNull()
  })
})

it('bounds aggregate metadata bytes at and above 4 MiB', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({
    ...item,
    slug: `guide-${i}`,
    versions: Array.from({ length: 1000 }, (_, j) => ({
      version: j + 1,
      title: 'x'.repeat(1000),
      bytes: 0,
      createdAt: 0,
    })),
  }))
  let excess =
    items.reduce((sum, a) => sum + JSON.stringify(a).length, 0) - ARTIFACT_LIMITS.metadataBytes
  expect(excess).toBeGreaterThan(0)
  for (const a of items)
    for (const v of a.versions) {
      const trim = Math.min(excess, v.title.length)
      v.title = v.title.slice(trim)
      excess -= trim
    }
  expect(excess).toBe(0)
  expect(parseArtifactList(items)).not.toBeNull()
  const first = items[0]?.versions[0]
  if (!first) throw new Error('fixture')
  first.title += 'x'
  expect(parseArtifactList(items)).toBeNull()
})
