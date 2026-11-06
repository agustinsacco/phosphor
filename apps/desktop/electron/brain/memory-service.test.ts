import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { MemoryRequest } from '@phosphor/brain-runtime/memory-protocol'

const state = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: state.fork } }))
const { createDesktopMemory } = await import('./memory-service')
beforeEach(() => state.fork.mockReset())

it.each([
  ['relative', '/workers/memory.js'],
  ['/profile/brain', 'relative.js'],
])('refuses unowned relative resources before spawning: %s, %s', (directory, worker) => {
  expect(() => createDesktopMemory(directory, worker)).toThrow('absolute owned resource paths')
  expect(state.fork).not.toHaveBeenCalled()
})

it('binds the portable store client to an isolated Electron utility process', async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() })
  child.postMessage.mockImplementation((request: MemoryRequest) => {
    child.emit('message', { id: request.id, ok: true, data: undefined })
  })
  state.fork.mockReturnValue(child)
  const store = createDesktopMemory('/profile/brain', '/workers/memory.js')
  expect(state.fork).toHaveBeenCalledWith('/workers/memory.js', ['/profile/brain'], {
    serviceName: 'Phosphor Brain Database',
    stdio: 'ignore',
    env: {},
  })
  await store.close()
  expect(child.postMessage).toHaveBeenCalledWith({ id: 1, method: 'close', args: [] })
  expect(child.kill).toHaveBeenCalledOnce()
})
