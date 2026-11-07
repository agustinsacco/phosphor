import { expect, it, vi } from 'vitest'
import { prepareLearningAuth } from './brain-learning-carrier-auth'

const model = { provider: 'openai', id: 'exact', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', contextWindow: 200000, maxTokens: 16000 }
const binding = { provider: model.provider, modelId: model.id, api: model.api, endpoint: model.baseUrl, accountId: 'current-slot', authMode: 'oauth', thinkingLevel: 'high' } as const
const selection = { provider: model.provider, modelId: model.id, thinkingLevel: 'high' } as const
function registry() {
  const streamSimple = vi.fn()
  return { boundRequestVersion: 1, find: vi.fn(() => model), prepareBoundRequest: vi.fn(async () => ({ binding, streamSimple })), streamSimple }
}
it('fails stock pi explicitly before credentials or streaming', async () => {
  await expect(prepareLearningAuth({ find: () => model }, selection, new AbortController().signal)).rejects.toThrow('boundRequestVersion')
})
it.each(['oauth', 'api-key'] as const)('binds a native %s current slot with no secret-returning API or fallback', async authMode => {
  const r = registry()
  r.prepareBoundRequest.mockResolvedValue({ binding: { ...binding, authMode }, streamSimple: r.streamSimple })
  const result = await prepareLearningAuth(r, selection, new AbortController().signal)
  expect(result.binding.authMode).toBe(authMode)
  expect(result.maxOutputTokens).toBe(16000)
  expect(r.prepareBoundRequest).toHaveBeenCalledWith(model, expect.objectContaining({ expected: selection, routePolicy: 'native', allowVirtual: false, allowFallback: false, allowCustom: false }))
  expect(r.streamSimple).not.toHaveBeenCalled()
})
it('rejects model selection fallback, foreign bindings, and malformed endpoint before a stream', async () => {
  const r = registry()
  r.find.mockReturnValue({ ...model, id: 'fallback' })
  await expect(prepareLearningAuth(r, selection, new AbortController().signal)).rejects.toThrow()
  r.find.mockReturnValue(model)
  r.prepareBoundRequest.mockResolvedValue({ binding: { ...binding, modelId: 'foreign' }, streamSimple: r.streamSimple })
  await expect(prepareLearningAuth(r, selection, new AbortController().signal)).rejects.toThrow()
  expect(r.streamSimple).not.toHaveBeenCalled()
})
it('requires explicit Claude slot, qualified version/capability and refuses thinking-losing cold replay', async () => {
  const r = registry()
  const claude = { ...selection, provider: 'pi-claude-cli' }
  await expect(prepareLearningAuth(r, claude, new AbortController().signal)).rejects.toThrow('explicit')
  await expect(prepareLearningAuth(r, { ...claude, accountId: 'assigned' }, new AbortController().signal)).rejects.toThrow()
  expect(r.prepareBoundRequest).not.toHaveBeenCalled()
})
