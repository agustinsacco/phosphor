import type * as Fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './__fixtures__/release'
import { downloadRelease, releaseUrl } from './download'
const fileHooks = vi.hoisted(() => ({ stalled: false }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) =>
      fileHooks.stalled ? new PassThrough() : fs.createReadStream(...args),
  }
})
const https = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: https.request }))
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  vi.useRealTimers()
  fileHooks.stalled = false
  https.request.mockReset()
  for (const f of fixtures.splice(0)) f.cleanup()
})
const signal = () => new AbortController().signal
it('uses flat override assets and correct per-release paths, and refuses unsafe base URLs', () => {
  expect(releaseUrl({}, 'host-latest', 'phosphor-host.manifest.json').href).toBe(
    'https://github.com/agustinsacco/Phosphor/releases/download/host-latest/phosphor-host.manifest.json',
  )
  expect(
    releaseUrl({ PHOSPHOR_HOST_RELEASE_URL: '' }, 'host-latest', 'phosphor-host.manifest.json'),
  ).toEqual(releaseUrl({}, 'host-latest', 'phosphor-host.manifest.json'))
  expect(
    releaseUrl({ PHOSPHOR_HOST_RELEASE_URL: 'file:///tmp/assets/' }, 'host-v1.2.3', 'a.tar.gz')
      .href,
  ).toBe('file:///tmp/assets/a.tar.gz')
  expect(
    releaseUrl(
      { PHOSPHOR_HOST_RELEASE_URL: 'https://example.test/assets' },
      'host-v1.2.3',
      'a.tar.gz',
    ).href,
  ).toBe('https://example.test/assets/a.tar.gz')
  for (const base of [
    'http://example.test',
    'ftp://example.test',
    'https://user:secret@example.test',
    'https://example.test/?x=1',
    'file:///tmp#hash',
  ])
    expect(() => releaseUrl({ PHOSPHOR_HOST_RELEASE_URL: base }, 'tag', 'file')).toThrow(
      'Invalid release URL',
    )
})
it('bounds file downloads exactly and aborts before reading', async () => {
  const f = fixture()
  fixtures.push(f)
  const file = join(f.home, 'download')
  writeFileSync(file, '1234')
  expect((await downloadRelease(pathToFileURL(file), 4, signal())).toString()).toBe('1234')
  await expect(downloadRelease(pathToFileURL(file), 3, signal())).rejects.toThrow('too large')
  const c = new AbortController()
  c.abort(130)
  await expect(downloadRelease(pathToFileURL(file), 4, c.signal)).rejects.toBe(130)
})
function replies(
  statuses: { code: number; location?: string; bytes?: string }[],
  timedOut = false,
) {
  https.request.mockImplementation(
    (
      _url,
      _options,
      receive: (
        response: Readable & { statusCode: number; headers: { location?: string } },
      ) => void,
    ) => {
      const req = new EventEmitter()
      return Object.assign(req, {
        setTimeout: (ms: number, callback: () => void) => {
          expect(ms).toBe(30000)
          if (timedOut) queueMicrotask(callback)
        },
        destroy: (error: Error) => {
          queueMicrotask(() => req.emit('error', error))
        },
        end: () => {
          if (timedOut) return
          const item = statuses.shift()
          if (!item) throw new Error('No fixture response')
          const stream = Readable.from([Buffer.from(item.bytes ?? '')])
          receive(
            Object.assign(stream, { statusCode: item.code, headers: { location: item.location } }),
          )
        },
      })
    },
  )
}
it('times out a stalled offline file request after 30 seconds', async () => {
  vi.useFakeTimers()
  fileHooks.stalled = true
  const result = expect(
    downloadRelease(new URL('file:///unused-fixture'), 4, signal()),
  ).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await result
})
it('bounds HTTPS response bytes and enforces its inactivity deadline', async () => {
  replies([{ code: 200, bytes: '1234' }])
  expect((await downloadRelease(new URL('https://example.test'), 4, signal())).length).toBe(4)
  replies([{ code: 200, bytes: '12345' }])
  await expect(downloadRelease(new URL('https://example.test'), 4, signal())).rejects.toThrow(
    'too large',
  )
  replies([], true)
  await expect(downloadRelease(new URL('https://example.test'), 4, signal())).rejects.toThrow(
    'timed out',
  )
})
it('refuses a redirect carrying credentials without sending a request to it', async () => {
  replies([{ code: 302, location: 'https://user:secret@example.test/private' }, { code: 200 }])
  await expect(downloadRelease(new URL('https://example.test'), 4, signal())).rejects.toThrow(
    'Invalid release URL',
  )
  expect(https.request).toHaveBeenCalledTimes(1)
})
it('allocates one signed-size buffer only for the final response, not for redirects', async () => {
  replies([
    ...Array.from({ length: 3 }, () => ({ code: 302, location: '/next' })),
    { code: 200, bytes: 'ok' },
  ])
  const alloc = vi.spyOn(Buffer, 'alloc')
  try {
    expect(
      (await downloadRelease(new URL('https://example.test'), 12345, signal())).toString(),
    ).toBe('ok')
    expect(alloc.mock.calls.filter(([size]) => size === 12345)).toHaveLength(1)
  } finally {
    alloc.mockRestore()
  }
})
it('follows exactly three HTTPS redirects, rejects four, downgrades, missing locations and HTTP errors', async () => {
  replies([
    ...Array.from({ length: 3 }, () => ({ code: 302, location: '/next' })),
    { code: 200, bytes: 'ok' },
  ])
  expect((await downloadRelease(new URL('https://example.test'), 4, signal())).toString()).toBe(
    'ok',
  )
  for (const statuses of [
    [
      ...Array.from({ length: 4 }, () => ({ code: 302, location: '/next' })),
      { code: 200, bytes: 'ok' },
    ],
    [{ code: 302, location: 'file:///tmp/no' }],
    [{ code: 302, location: 'http://example.test' }],
    [{ code: 302 }],
    [{ code: 404 }],
  ]) {
    const error = statuses[0]?.code === 404 ? 'Release download failed' : 'Invalid release redirect'
    replies(statuses)
    await expect(downloadRelease(new URL('https://example.test'), 4, signal())).rejects.toThrow(
      error,
    )
  }
  replies([{ code: 302, location: 'https://[' }])
  await expect(downloadRelease(new URL('https://example.test'), 4, signal())).rejects.toThrow(
    'Invalid release redirect',
  )
  await expect(downloadRelease(new URL('http://example.test'), 4, signal())).rejects.toThrow(
    'Invalid release URL',
  )
})
