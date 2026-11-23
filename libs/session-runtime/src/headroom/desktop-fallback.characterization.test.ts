import { expect, it, vi } from 'vitest'
import { HEADROOM_PROXY_PORT } from './proxy-process'
import { createHeadroomSupervisor } from './supervisor'

it('the in-app fallback adopts a healthy 8787 endpoint and gives lanes its URL', async () => {
  const spawnImpl = vi.fn((): never => {
    throw new Error('must not spawn')
  })
  const fetchImpl = vi.fn(async () => new Response('{}'))
  const supervisor = createHeadroomSupervisor({
    port: HEADROOM_PROXY_PORT,
    spawnImpl,
    fetchImpl,
    envImpl: async () => ({}),
    isEnabled: () => true,
    setEnabled: () => {},
    resolveBinaryImpl: async () => null,
    versionImpl: async () => null,
    logImpl: () => {},
    onWillQuit: () => {},
  })
  await supervisor.ensure()
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/health', expect.anything())
  expect(supervisor.sessionEnv()).toEqual({ PHOSPHOR_HEADROOM_URL: 'http://127.0.0.1:8787' })
  await supervisor.ensure()
  expect(spawnImpl).not.toHaveBeenCalled()
})
