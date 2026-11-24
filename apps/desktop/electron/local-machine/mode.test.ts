import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalDaemonAccess } from './mode'

const access: LocalDaemonAccess = {
  location: { kind: 'dev', socket: '/tmp/m2a/s.sock', configDir: '/tmp/m2a/config' },
  ownerKey: () => Promise.reject(new Error('unused')),
}
const load = () => import('./mode')

beforeEach(() => {
  vi.resetModules()
})

it('is in-app until the launch gate decides, and every guard is open', async () => {
  const mode = await load()
  expect(mode.localRuntimeMode()).toBe('in-app')
  expect(() => mode.assertInAppRuntime('start a lane')).not.toThrow()
})

it('decides once: the same mode again is a no-op, another mode throws', async () => {
  const mode = await load()
  mode.decideLocalRuntimeMode('daemon', access)
  expect(() => mode.decideLocalRuntimeMode('daemon', access)).not.toThrow()
  expect(() => mode.decideLocalRuntimeMode('in-app')).toThrow('decided once')
  expect(mode.localRuntimeMode()).toBe('daemon')
  expect(() => mode.assertInAppRuntime('start a lane')).toThrow(mode.IN_APP_RUNTIME_REFUSED)
})

it('an in-app decision cannot become daemon mode later', async () => {
  const mode = await load()
  mode.decideLocalRuntimeMode('in-app')
  expect(() => mode.decideLocalRuntimeMode('daemon', access)).toThrow('decided once')
  expect(() => mode.assertInAppRuntime('start a lane')).not.toThrow()
})

it('runs daemon listeners once with the access, whether they subscribe before or after', async () => {
  const mode = await load()
  const before = vi.fn()
  const removed = vi.fn()
  mode.onDaemonMode(before)
  mode.onDaemonMode(removed)()
  mode.decideLocalRuntimeMode('daemon', access)
  mode.decideLocalRuntimeMode('daemon', access)
  const after = vi.fn()
  mode.onDaemonMode(after)
  expect(before).toHaveBeenCalledExactlyOnceWith(access)
  expect(after).toHaveBeenCalledExactlyOnceWith(access)
  expect(removed).not.toHaveBeenCalled()
})

it('never runs daemon listeners in-app', async () => {
  const mode = await load()
  const listener = vi.fn()
  mode.onDaemonMode(listener)
  mode.decideLocalRuntimeMode('in-app')
  mode.onDaemonMode(listener)
  expect(listener).not.toHaveBeenCalled()
})

it('names the refused action on the error', async () => {
  const mode = await load()
  mode.decideLocalRuntimeMode('daemon', access)
  try {
    mode.assertInAppRuntime('fork a session file')
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(mode.InAppRuntimeRefused)
    expect((error as InstanceType<typeof mode.InAppRuntimeRefused>).action).toBe(
      'fork a session file',
    )
  }
})
