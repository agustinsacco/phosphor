import { describe, expect, it } from 'vitest'
import {
  HOST_RELEASE_ARTIFACT_MAX_BYTES,
  HOST_RELEASE_FEATURES,
  HOST_RELEASE_MANIFEST_V2,
  HOST_RELEASE_TARGETS,
  HOST_RELEASE_TARGETS_V2,
  LEGACY_HOST_RELEASE_TARGETS,
  hostReleaseManifestV2Name,
  parseHostReleaseManifest,
  parseHostReleaseManifestV2,
} from './host-release'
const artifact = {
  target: 'linux-x64',
  file: 'phosphor-host-1.2.3-linux-x64.tar.gz',
  bytes: 1,
  sha256: 'a'.repeat(64),
}
const manifest = {
  schema: 1,
  version: '1.2.3',
  node: '24.14.1',
  protocols: [1],
  sourceCommit: 'b'.repeat(40),
  artifacts: [artifact],
}
describe('parseHostReleaseManifest', () => {
  it('accepts bounded release metadata', () => {
    expect(parseHostReleaseManifest(manifest)).toEqual(manifest)
    expect(
      parseHostReleaseManifest({
        ...manifest,
        protocols: [1, 2, 3, 4, 5, 6, 7, 65535],
        artifacts: [{ ...artifact, bytes: HOST_RELEASE_ARTIFACT_MAX_BYTES }],
      }),
    ).not.toBeNull()
  })
  it('rejects unsafe versions, unknown keys, invalid counts and artifact metadata', () => {
    for (const value of [
      null,
      {},
      [],
      { ...manifest, extra: true },
      ...['../1.2.3', '1/2/3', '1.2.3\n', '01.2.3', '1.2', '1000000000.2.3', '1.2.3-dev'].map(
        (version) => ({ ...manifest, version }),
      ),
      { ...manifest, node: 'bad' },
      { ...manifest, sourceCommit: 'A'.repeat(40) },
      ...[[], [0], [65536], [1, 1], Array.from({ length: 9 }, (_, i) => i + 1), ['1']].map(
        (protocols) => ({ ...manifest, protocols }),
      ),
      { ...manifest, artifacts: [] },
      { ...manifest, artifacts: [artifact, artifact] },
      ...[
        { target: 'darwin-x64' },
        { file: '../node' },
        { bytes: 0 },
        { bytes: 1.5 },
        { bytes: HOST_RELEASE_ARTIFACT_MAX_BYTES + 1 },
        { sha256: 'a'.repeat(63) },
        { sha256: 'A'.repeat(64) },
        { extra: true },
      ].map((change) => ({ ...manifest, artifacts: [{ ...artifact, ...change }] })),
    ])
      expect(parseHostReleaseManifest(value), JSON.stringify(value)).toBeNull()
  })
})

/** A v1 manifest as host-v0.2.89 publishes it; v1 readers must keep reading it unchanged. */
const FROZEN_V1 = {
  schema: 1,
  version: '0.2.89',
  protocols: [1],
  node: '24.14.1',
  sourceCommit: 'c'.repeat(40),
  artifacts: ['linux-x64', 'linux-arm64', 'darwin-arm64'].map((target) => ({
    target,
    file: `phosphor-host-0.2.89-${target}.tar.gz`,
    bytes: 1,
    sha256: 'd'.repeat(64),
  })),
}

describe('host release manifest v2', () => {
  const darwinX64 = {
    ...FROZEN_V1.artifacts[0],
    target: 'darwin-x64',
    file: 'phosphor-host-0.2.89-darwin-x64.tar.gz',
  }
  const v2 = {
    ...FROZEN_V1,
    schema: 2,
    features: ['local-mode', 'owner-socket'],
    artifacts: [...FROZEN_V1.artifacts, darwinX64],
  }

  it('keeps v1 frozen at three targets and refuses a fourth', () => {
    expect(LEGACY_HOST_RELEASE_TARGETS).toBe(HOST_RELEASE_TARGETS)
    expect(HOST_RELEASE_TARGETS).toStrictEqual(['linux-x64', 'linux-arm64', 'darwin-arm64'])
    expect(parseHostReleaseManifest(FROZEN_V1)).toStrictEqual(FROZEN_V1)
    expect(parseHostReleaseManifest({ ...FROZEN_V1, artifacts: v2.artifacts })).toBeNull()
  })

  it('names v2 assets apart from v1 and adds darwin-x64 only to v2', () => {
    expect(HOST_RELEASE_MANIFEST_V2).toBe('phosphor-host.manifest.v2.json')
    expect(hostReleaseManifestV2Name('v0.2.89')).toBe('phosphor-host-v0.2.89.manifest.v2.json')
    expect(HOST_RELEASE_TARGETS_V2).toStrictEqual([...HOST_RELEASE_TARGETS, 'darwin-x64'])
    expect(HOST_RELEASE_FEATURES).toContain('local-mode')
  })

  it('reads v2 and ignores unknown keys, targets and features', () => {
    expect(parseHostReleaseManifestV2(v2)).toStrictEqual(v2)
    const future = {
      ...v2,
      channel: 'beta',
      features: [...v2.features, 'teleport'],
      artifacts: [
        ...FROZEN_V1.artifacts,
        { ...darwinX64, extra: 1 },
        { target: 'windows-arm64', file: 'anything' },
      ],
    }
    expect(parseHostReleaseManifestV2(future)).toStrictEqual({ ...v2, features: future.features })
  })

  it('stays strict on known fields and bounds', () => {
    for (const bad of [
      { ...v2, schema: 1 },
      { ...v2, features: ['Local'] },
      { ...v2, features: ['a', 'a'] },
      { ...v2, features: Array.from({ length: 33 }, (_, i) => `f${i}`) },
      { ...v2, artifacts: [darwinX64, darwinX64] },
      { ...v2, artifacts: [{ ...darwinX64, file: 'other.tar.gz' }] },
      { ...v2, artifacts: [] },
      {
        ...v2,
        artifacts: Array.from({ length: 17 }, () => ({ ...darwinX64, target: 'future-x' })),
      },
    ])
      expect(parseHostReleaseManifestV2(bad)).toBeNull()
  })
})
