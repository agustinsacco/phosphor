import { afterEach, describe, expect, it } from 'vitest'
import { localReleaseMirror, type LocalPublish } from './__fixtures__/local-release'
import { scratch } from './__fixtures__/scratch'
import { ReleaseNotFound } from './download'
import { fetchLocalRelease } from './release-v2'

const fixtures: ReturnType<typeof scratch>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
const signal = () => new AbortController().signal
function check(options: LocalPublish) {
  const f = scratch()
  fixtures.push(f)
  const mirror = localReleaseMirror(f.home)
  mirror.publish(options)
  return fetchLocalRelease({ env: mirror.env, keys: mirror.keys }, signal())
}

describe('fetchLocalRelease', () => {
  it('reads the signed v2 manifest with its features and every target', async () => {
    const found = await check({ targets: ['darwin-arm64', 'darwin-x64'] })
    expect(found.manifest).toBe(2)
    if (found.manifest !== 2) return
    expect(found.release.features).toEqual(['local-mode', 'owner-socket'])
    expect(found.release.artifacts.map((a) => a.target)).toEqual(['darwin-arm64', 'darwin-x64'])
  })
  it('falls back to the v1 manifest only when v2 is absent', async () => {
    await expect(check({ v2: 'absent' })).resolves.toEqual({ manifest: 1, version: '1.2.3' })
  })
  it.each([
    ['unsigned', { v2: 'unsigned' }, 'has no signature'],
    ['signed by another key', { v2: 'wrong-key' }, 'Invalid release manifest or signature'],
    ['unparseable', { v2: 'invalid' }, 'Invalid release manifest or signature'],
    ['disagreeing with v1', { v1: 'other-commit' }, 'disagree'],
    ['missing its v1 twin', { v1: 'absent' }, 'no v1 manifest'],
  ] as const)('fails closed, without a v1 fallback, on a v2 %s', async (_name, options, text) => {
    const error: unknown = await check(options).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ReleaseNotFound)
    expect((error as Error).message).toContain(text)
  })
  it('fails when neither manifest exists, and refuses with no pinned keys', async () => {
    await expect(check({ v1: 'absent', v2: 'absent' })).rejects.toBeInstanceOf(ReleaseNotFound)
    await expect(fetchLocalRelease({ env: {}, keys: [] }, signal())).rejects.toThrow(
      'No Host release keys',
    )
  })
  it('refuses a plain-HTTP or credentialed release URL before any request', async () => {
    for (const url of ['http://example.test', 'https://u:p@example.test'])
      await expect(
        fetchLocalRelease({ env: { PHOSPHOR_HOST_RELEASE_URL: url }, keys: [] }, signal()),
      ).rejects.toThrow()
  })
})
