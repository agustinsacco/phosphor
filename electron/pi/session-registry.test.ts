import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ dispose: vi.fn() }))
vi.mock('./rpc-client', () => ({
  PiRpcClient: class {
    sessionFile = '/session'
    pid = 123
    spawn() {}
    dispose = state.dispose
  },
}))
import { SessionRegistry } from './session-registry'

it('keeps ownership until disposal finishes and coalesces concurrent disposal', async () => {
  let release!: () => void
  state.dispose.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const registry = new SessionRegistry()
  const session = registry.create('/repo', {})
  expect(registry.list()[0]?.diskPath).toBe('/session')
  const first = registry.dispose(session.sessionId)
  const second = registry.dispose(session.sessionId)
  await Promise.resolve()
  expect(registry.get(session.sessionId)).toBe(session)
  expect(state.dispose).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([first, second])
  expect(registry.list()).toEqual([])
})
