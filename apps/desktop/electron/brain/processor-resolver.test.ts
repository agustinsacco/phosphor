import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ invoke: vi.fn(), health: vi.fn() }))
vi.mock('../pi/invoker', () => ({ resolvePiInvoker: state.invoke }))
vi.mock('../pi/health', () => ({ cachedPiHealth: state.health }))
import { resolveBrainProcessor } from './processor-resolver'
beforeEach(() => {
  state.invoke.mockReset().mockResolvedValue({
    binaryPath: '/node',
    prefixArgs: ['/pi'],
    stub: false,
    env: {
      PATH: '/bin',
      TMPDIR: '/tmp',
      HOME: '/private-home',
      PI_CODING_AGENT_DIR: '/shared-config',
      ANTHROPIC_API_KEY: 'selected',
      OPENAI_API_KEY: 'other',
      HF_TOKEN: 'private',
      PHOSPHOR_BRAIN_TOKEN: 'stale',
      NODE_OPTIONS: '--require malicious',
    },
  })
  state.health.mockReset().mockResolvedValue({ ok: true, version: '1.4.0' })
})
it('forwards only basic process variables and the selected native credential', async () => {
  expect(await resolveBrainProcessor({ provider: 'anthropic', id: 'exact' })).toEqual({
    binaryPath: '/node',
    prefixArgs: ['/pi'],
    version: '1.4.0',
    env: { PATH: '/bin', TMPDIR: '/tmp', ANTHROPIC_API_KEY: 'selected' },
  })
})
it('rejects unsupported providers without discovering pi or importing auth', async () => {
  await expect(resolveBrainProcessor({ provider: 'openai-codex', id: 'exact' })).rejects.toThrow(
    'OAuth',
  )
  expect(state.invoke).not.toHaveBeenCalled()
})
it('rejects missing credentials, unverified versions and the test stub', async () => {
  state.invoke.mockResolvedValueOnce({ binaryPath: '/pi', prefixArgs: [], stub: true, env: {} })
  await expect(resolveBrainProcessor({ provider: 'openai', id: 'exact' })).rejects.toThrow(
    'test stub',
  )
  state.health.mockResolvedValueOnce({ ok: true })
  await expect(resolveBrainProcessor({ provider: 'openai', id: 'exact' })).rejects.toThrow(
    'verified',
  )
  state.invoke.mockResolvedValueOnce({
    binaryPath: '/pi',
    prefixArgs: [],
    stub: false,
    env: { OPENAI_API_KEY: ' ' },
  })
  await expect(resolveBrainProcessor({ provider: 'openai', id: 'exact' })).rejects.toThrow(
    'OPENAI_API_KEY',
  )
})
