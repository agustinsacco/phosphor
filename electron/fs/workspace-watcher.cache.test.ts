import { afterEach, expect, it, vi } from 'vitest'
import chokidar from 'chokidar'
import { gitInfoCache } from './git-info-cache'
import { unwatchAllWorkspaces, watchWorkspace } from './workspace-watcher'

const send = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
}))
vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: { watch: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })) },
  }
})
afterEach(async () => {
  await unwatchAllWorkspaces()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('invalidates once per debounced batch, before notifying Git display consumers', async () => {
  vi.useFakeTimers()
  const invalidate = vi.spyOn(gitInfoCache, 'invalidate')
  watchWorkspace('/repo')
  const watcher = vi.mocked(chokidar.watch).mock.results[0]!.value
  for (let i = 0; i < 100; i++) watcher.emit('change', `/repo/file-${i}`)
  expect(invalidate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(invalidate).toHaveBeenCalledExactlyOnceWith('/repo')
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0]?.[1].paths).toHaveLength(100)
  expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!)
})
