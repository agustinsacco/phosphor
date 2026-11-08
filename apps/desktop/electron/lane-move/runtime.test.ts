import { expect, it, vi } from 'vitest'
import { localTransferRuntime } from './runtime'

const probe = vi.hoisted(() =>
  vi.fn(async () => [{ provider: 'project-provider', id: 'project-model' }]),
)
vi.mock('../pi/model-catalogue', () => ({ listModelsViaRpc: probe }))
vi.mock('../pi/health', () => ({ cachedPiHealth: async () => ({ ok: true, version: '0.86.0' }) }))
vi.mock('../pi/invoker', () => ({
  resolvePiInvoker: async () => ({ binaryPath: '/pi', prefixArgs: [], env: { PATH: '/bin' } }),
}))
vi.mock('../pi/stub', () => ({ piStubPath: () => null }))
vi.mock('@phosphor/session-runtime/lane-transfer/claude-version', () => ({
  transferClaudeVersion: async () => '0.10.0',
}))

it('asks pi for available models in the destination workspace, not the home catalogue', async () => {
  expect(await localTransferRuntime(true, '/target/project')).toEqual({
    piVersion: '0.86.0',
    claudeVersion: '0.10.0',
    models: [{ provider: 'project-provider', id: 'project-model' }],
  })
  expect(probe).toHaveBeenCalledWith('/pi', [], { PATH: '/bin' }, '/target/project')
  probe.mockClear()
  await localTransferRuntime(false, '/source')
  expect(probe).not.toHaveBeenCalled()
})
