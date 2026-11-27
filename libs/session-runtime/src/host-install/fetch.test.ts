import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_RELEASE_MANIFEST_V2, hostReleaseManifestV2Name } from '@phosphor/shared/host-release'
import { afterEach, describe, expect, it } from 'vitest'
import { localReleaseMirror, type LocalPublish } from './__fixtures__/local-release'
import { scratch } from './__fixtures__/scratch'
import { ReleaseNotFound } from './download'
import { fetchSignedRelease, UpdateFailure } from './fetch'

const fixtures: ReturnType<typeof scratch>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
const signal = () => new AbortController().signal

function mirror(options: LocalPublish) {
  const f = scratch()
  fixtures.push(f)
  const m = localReleaseMirror(f.home)
  m.publish(options)
  return m
}
function fetchFor(
  m: ReturnType<typeof mirror>,
  target: string,
  requested?: string,
  installed = '1.0.0',
) {
  const [platform, arch] = target.split('-') as [NodeJS.Platform, string]
  return fetchSignedRelease(
    { env: m.env, keys: m.keys, platform, arch },
    requested,
    installed,
    signal(),
  )
}
/** Copies `host-latest`'s manifests to the names a requested version reads. */
function publishAsRequested(m: ReturnType<typeof mirror>, version: string) {
  for (const [from, to] of [
    ['phosphor-host.manifest.json', `phosphor-host-${version}.manifest.json`],
    [HOST_RELEASE_MANIFEST_V2, hostReleaseManifestV2Name(version)],
  ] as const)
    for (const suffix of ['', '.sig'])
      copyFileSync(join(m.assets, from + suffix), join(m.assets, to + suffix))
}

describe('fetchSignedRelease', () => {
  it('installs on an Intel Mac from the signed v2 manifest', async () => {
    const m = mirror({ version: '1.3.0', targets: ['darwin-arm64', 'darwin-x64', 'linux-x64'] })
    const found = await fetchFor(m, 'darwin-x64')
    expect(found.version).toBe('1.3.0')
    expect(found.artifact).toMatchObject({
      target: 'darwin-x64',
      file: 'phosphor-host-1.3.0-darwin-x64.tar.gz',
    })
    expect(found.notice).toBeUndefined()
    await expect(fetchFor(m, 'darwin-arm64')).resolves.toMatchObject({ version: '1.3.0' })
  })

  it('reads a requested version’s own v2 manifest', async () => {
    const m = mirror({ version: '1.3.0', targets: ['darwin-x64', 'linux-x64'] })
    publishAsRequested(m, '1.3.0')
    m.publish({ version: '1.4.0', targets: ['linux-x64'] })
    await expect(fetchFor(m, 'darwin-x64', '1.3.0')).resolves.toMatchObject({
      version: '1.3.0',
      artifact: { target: 'darwin-x64' },
    })
  })

  it('falls back to the v1 manifest when no v2 is published', async () => {
    const m = mirror({ version: '1.3.0', v2: 'absent', targets: ['darwin-x64', 'linux-x64'] })
    await expect(fetchFor(m, 'linux-x64')).resolves.toMatchObject({ version: '1.3.0' })
    const refused: unknown = await fetchFor(m, 'darwin-x64').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(UpdateFailure)
    expect(refused).toMatchObject({ message: 'Release does not support this Host.', exitCode: 69 })
  })

  it.each([
    ['unsigned', { v2: 'unsigned' }],
    ['signed by another key', { v2: 'wrong-key' }],
    ['unparseable', { v2: 'invalid' }],
    ['disagreeing with v1', { v1: 'other-commit' }],
  ] as const)('refuses a published v2 %s, without a v1 fallback', async (_name, options) => {
    const m = mirror({ ...options, targets: ['linux-x64'] })
    const error: unknown = await fetchFor(m, 'linux-x64').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ReleaseNotFound)
  })

  it('keeps the downgrade guard and the requested-version check on a v2 release', async () => {
    const m = mirror({ version: '1.3.0', targets: ['darwin-x64', 'linux-x64'] })
    await expect(fetchFor(m, 'darwin-x64', undefined, '1.4.0')).rejects.toMatchObject({
      message: 'refusing to downgrade',
      exitCode: 64,
    })
    publishAsRequested(m, '1.2.0')
    await expect(fetchFor(m, 'darwin-x64', '1.2.0')).rejects.toMatchObject({
      message: 'Release version does not match the request.',
      exitCode: 64,
    })
  })
})
