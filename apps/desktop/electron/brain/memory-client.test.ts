import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryClient, type MemoryProcess } from './memory-client'
import type { MemoryRequest, MemoryResponse } from './memory-protocol'

function fixture() {
  let message!: (message: MemoryResponse) => void
  let exit!: () => void
  const posts: MemoryRequest[] = []
  const child: MemoryProcess = { post: (request) => { posts.push(request) }, onMessage: (listener) => { message = listener }, onExit: (listener) => { exit = listener }, kill: vi.fn() }
  const client = createMemoryClient(child, 100)
  return { child, client, posts, message: (response: MemoryResponse) => message(response), exit: () => exit() }
}
afterEach(() => vi.useRealTimers())
it('correlates typed replies and closes once, rejecting subsequent requests', async () => {
  const f = fixture()
  const request = f.client.pendingPurges()
  f.message({ id: f.posts[0]!.id, ok: true, data: [] })
  await expect(request).resolves.toEqual([])
  const first = f.client.close(), second = f.client.close()
  expect(first).toBe(second)
  f.message({ id: f.posts[1]!.id, ok: true, data: undefined })
  await first
  await expect(f.client.snapshot()).rejects.toThrow('closed')
})
it('poisons timed-out work so a late mutation cannot share a reused connection', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const pending = expect(f.client.snapshot()).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(100)
  await pending
  expect(f.child.kill).toHaveBeenCalled()
  await expect(f.client.pendingPurges()).rejects.toThrow('closed')
})
it('rejects all pending requests on worker exit and bounds its queue', async () => {
  const f = fixture()
  const pending = Array.from({ length: 64 }, () => expect(f.client.snapshot()).rejects.toThrow('exited'))
  await expect(f.client.snapshot()).rejects.toThrow('exceeds limit')
  f.exit()
  await Promise.all(pending)
})
it('rejects oversized input before posting', async () => {
  const f = fixture()
  await expect(f.client.read('x'.repeat(9_000_001), [])).rejects.toThrow('exceeds limit')
  expect(f.posts).toHaveLength(0)
})
