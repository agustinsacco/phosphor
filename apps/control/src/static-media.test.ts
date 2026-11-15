import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serveStatic } from './static'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-media-'))
  await Promise.all(
    ['demo.mp4', 'demo.webm', 'page.html'].map((name) => writeFile(join(root, name), '0123456789')),
  )
  await writeFile(join(root, 'empty.mp4'), '')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return serveStatic(new Request(`http://localhost/${path}`, { headers, method }), root)
}

it.each([
  ['demo.mp4', 'video/mp4'],
  ['demo.webm', 'video/webm'],
])('serves %s with a browser-playable MIME type and byte-range support', async (path, type) => {
  const response = await request(path, { 'accept-encoding': 'gzip' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(type)
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBe('10')
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('cache-control')).not.toContain('immutable')
  expect(await response.text()).toBe('0123456789')
})

it.each([
  ['bytes=0-1', '01', 'bytes 0-1/10'],
  ['bytes=4-', '456789', 'bytes 4-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=8-100', '89', 'bytes 8-9/10'],
  ['bytes=-100', '0123456789', 'bytes 0-9/10'],
])('supports media seek %s', async (range, body, contentRange) => {
  const response = await request('demo.mp4', { range })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe(contentRange)
  expect(response.headers.get('content-length')).toBe(String(body.length))
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.text()).toBe(body)
})

it.each(['bytes=10-', 'bytes=20-30', 'bytes=-0'])('refuses unsatisfiable %s', async (range) => {
  const response = await request('demo.mp4', { range })
  expect(response.status).toBe(416)
  expect(response.headers.get('content-range')).toBe('bytes */10')
  expect(response.headers.get('content-length')).toBe('0')
  expect(await response.text()).toBe('')
})

it('handles an empty video without opening an invalid stream', async () => {
  const response = await request('empty.mp4', { range: 'bytes=0-' })
  expect(response.status).toBe(416)
  expect(response.headers.get('content-range')).toBe('bytes */0')
  expect(await response.text()).toBe('')
})

it.each(['bytes=5-2', 'bytes=0-1,4-5', 'bytes=bad', 'items=0-1', 'bytes=-'])(
  'ignores unsupported or malformed ranges: %s',
  async (range) => {
    const response = await request('demo.mp4', { range })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    expect(await response.text()).toBe('0123456789')
  },
)

it('ignores ranges on HEAD, non-video files, and unvalidated If-Range requests', async () => {
  const head = await request('demo.mp4', { range: 'bytes=0-1' }, 'HEAD')
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe('10')
  expect(head.headers.get('content-range')).toBeNull()
  expect(head.body).toBeNull()
  for (const [path, headers] of [
    ['page.html', { range: 'bytes=0-1' }],
    ['demo.mp4', { range: 'bytes=0-1', 'if-range': '"old"' }],
  ] as const) {
    const response = await request(path, headers)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    expect(await response.text()).toBe('0123456789')
  }
})
