import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { probeStagedBundle } from './probe'
import { requireLocalRelease } from './release-source'
import type { HostReleaseManifestV2 } from '@phosphor/shared/host-release'
const stages: string[] = []
afterEach(() => {
  for (const path of stages.splice(0)) rmSync(path, { recursive: true, force: true })
})
it.each([true, false])(
  'probes the staged runtime with a clean environment; features present=%s',
  async (hasFeatures) => {
    const dir = mkdtempSync(join(tmpdir(), 'local-probe-'))
    stages.push(dir)
    mkdirSync(join(dir, 'node/bin'), { recursive: true })
    const features = ['local-mode', 'owner-socket']
    writeFileSync(
      join(dir, 'node/bin/node'),
      `#!/bin/sh\n[ "$1" = "${join(dir, 'lib/phosphor.mjs')}" ] && [ "$2" = version ] && [ "$3" = --json ] && [ "$PATH" = /usr/bin:/bin ] && [ -z "$HOME" ] || exit 1\necho '${JSON.stringify({ hostVersion: '1.2.3', protocolVersion: 1, ...(hasFeatures && { features }) })}'`,
      { mode: 0o700 },
    )
    const result = await probeStagedBundle(dir, new AbortController().signal)
    const artifact = {
      target: 'darwin-x64' as const,
      file: 'fixture',
      bytes: 1,
      sha256: 'a'.repeat(64),
    }
    const manifest: HostReleaseManifestV2 = {
      schema: 2,
      version: '1.2.3',
      node: '1.2.3',
      sourceCommit: 'a'.repeat(40),
      protocols: [1],
      features,
      artifacts: [artifact],
    }
    const check = () => requireLocalRelease(manifest, result, artifact.target)
    if (hasFeatures) expect(check()).toEqual(artifact)
    else expect(check).toThrow()
    expect(() =>
      requireLocalRelease({ ...manifest, features: [] }, result, artifact.target),
    ).toThrow()
    expect(() =>
      requireLocalRelease({ ...manifest, version: '1.2.4' }, result, artifact.target),
    ).toThrow()
  },
)
