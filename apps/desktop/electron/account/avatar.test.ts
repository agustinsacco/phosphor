import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AVATAR_BYTES, AVATAR_MS, avatarUrl, createAvatarCache, fetchAvatar } from './avatar'
import { createVault } from './vault'
import { fakeCipher, USER } from './__fixtures__/fakes'

const URL = 'https://avatars.githubusercontent.com/u/123?v=4'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-avatar-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('accepts only credential-free HTTPS on the exact GitHub avatar host', async () => {
  expect(avatarUrl(URL)).toBe(URL)
  const fetchImpl = vi.fn<typeof fetch>()
  for (const url of [
    null,
    1,
    '',
    'http://avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://github.com/u/1',
    'https://a:b@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:444/u/1',
    'data:image/png;base64,AA==',
    'https://avatars.githubusercontent.com/' + 'a'.repeat(2048),
  ]) {
    expect(avatarUrl(url)).toBeNull()
    if (typeof url === 'string') expect(await fetchAvatar(url, fetchImpl)).toBeNull()
  }
  expect(fetchImpl).not.toHaveBeenCalled()
})
it('omits credentials, refuses redirects and bounds the entire request at ten seconds', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png; charset=binary' },
    })
  })
  expect(await fetchAvatar(URL, fetchImpl)).toBe('data:image/png;base64,AQID')
  expect(timeout).toHaveBeenCalledWith(AVATAR_MS)
  expect(AVATAR_MS).toBe(10_000)
  for (const problem of [
    new TypeError('redirect off-host'),
    new DOMException('timeout', 'TimeoutError'),
  ]) {
    fetchImpl.mockRejectedValueOnce(problem)
    expect(await fetchAvatar(URL, fetchImpl)).toBeNull()
  }
})
it('rejects failed responses, empty bodies and non-image content types', async () => {
  for (const response of [
    new Response('x', { status: 404 }),
    new Response('x'),
    new Response('x', { headers: { 'content-type': 'text/html' } }),
    new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    new Response(null, { headers: { 'content-type': 'image/png' } }),
    new Response('', { headers: { 'content-type': 'image/png' } }),
  ]) {
    expect(
      await fetchAvatar(
        URL,
        vi.fn(async () => response),
      ),
    ).toBeNull()
  }
  for (const type of ['image/jpeg', 'image/gif', 'image/webp']) {
    expect(
      await fetchAvatar(
        URL,
        vi.fn(async () => new Response('image', { headers: { 'content-type': type } })),
      ),
    ).toMatch(`data:${type};base64,`)
  }
})
it('caps declared and streamed image bytes at 256 KiB, including one byte past', async () => {
  expect(AVATAR_BYTES).toBe(256 * 1024)
  for (const length of [AVATAR_BYTES, AVATAR_BYTES + 1]) {
    const image = new Uint8Array(length).fill(1)
    const fetchImpl = vi.fn(
      async () => new Response(image, { headers: { 'content-type': 'image/png' } }),
    )
    const result = await fetchAvatar(URL, fetchImpl)
    if (length === AVATAR_BYTES)
      expect(result).toBe(`data:image/png;base64,${Buffer.from(image).toString('base64')}`)
    else expect(result).toBeNull()
  }
  for (const declared of [String(AVATAR_BYTES + 1), 'invalid', '-1']) {
    expect(
      await fetchAvatar(
        URL,
        vi.fn(
          async () =>
            new Response('x', {
              headers: { 'content-type': 'image/png', 'content-length': declared },
            }),
        ),
      ),
    ).toBeNull()
  }
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(AVATAR_BYTES))
        controller.enqueue(new Uint8Array(1))
      },
      cancel,
    }),
    { headers: { 'content-type': 'image/png', 'content-length': '1' } },
  )
  expect(
    await fetchAvatar(
      URL,
      vi.fn(async () => response),
    ),
  ).toBeNull()
  expect(cancel).toHaveBeenCalledOnce()
})
it('stores a bounded avatar beside the profile, tied to its owner, and deletes it on sign-out', () => {
  const cache = createAvatarCache(dir)
  expect(cache.read(USER.id)).toBeNull()
  const data = 'data:image/png;base64,AQID'
  cache.save(USER.id, data)
  expect(cache.read(USER.id)).toBe(data)
  expect(cache.read('other-user')).toBeNull()
  if (process.platform !== 'win32') {
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'avatar.json')).mode & 0o777).toBe(0o600)
    chmodSync(join(dir, 'avatar.json'), 0o644)
    expect(cache.read(USER.id)).toBeNull()
  }
  const vault = createVault(dir, fakeCipher().cipher)
  vault.clear()
  expect(readdirSync(dir)).toEqual([])
})
it('rejects damaged, oversized and non-canonical cached images without leaking errors', () => {
  const cache = createAvatarCache(dir)
  for (const dataUrl of [
    'https://avatars.githubusercontent.com/u/1',
    'data:image/png;base64,AR==',
    `data:image/png;base64,${Buffer.alloc(AVATAR_BYTES + 1).toString('base64')}`,
  ]) {
    cache.save(USER.id, dataUrl)
    expect(readdirSync(dir)).toEqual([])
    writeFileSync(join(dir, 'avatar.json'), JSON.stringify({ userId: USER.id, dataUrl }), {
      mode: 0o600,
    })
    expect(cache.read(USER.id)).toBeNull()
    rmSync(join(dir, 'avatar.json'))
  }
  writeFileSync(join(dir, 'avatar.json'), '{', { mode: 0o600 })
  expect(cache.read(USER.id)).toBeNull()
})
it('does not follow a symlink when reading the cache', () => {
  const path = join(dir, 'avatar.json')
  const target = join(dir, 'other.json')
  writeFileSync(
    target,
    JSON.stringify({ userId: USER.id, dataUrl: 'data:image/png;base64,AQID' }),
    { mode: 0o600 },
  )
  symlinkSync(target, path)
  expect(createAvatarCache(dir).read(USER.id)).toBeNull()
})
