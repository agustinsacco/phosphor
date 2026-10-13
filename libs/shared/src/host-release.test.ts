import { describe, expect, it } from 'vitest'
import { HOST_RELEASE_ARTIFACT_MAX_BYTES, parseHostReleaseManifest } from './host-release'
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
