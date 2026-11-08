import { expect, it, vi } from 'vitest'
import type { BrainLearningBinding } from '@phosphor/shared/brain-learning'
import { prepareLearningAuth } from './brain-learning-carrier-auth'

const model = {
  provider: 'openai',
  id: 'exact',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  contextWindow: 200000,
  maxTokens: 16000,
}
const binding: BrainLearningBinding = {
  provider: model.provider,
  modelId: model.id,
  api: model.api,
  endpoint: model.baseUrl,
  accountId: 'current-slot',
  authMode: 'oauth',
  thinkingLevel: 'high',
}
const selection = { provider: model.provider, modelId: model.id, thinkingLevel: 'high' } as const
function registry() {
  const streamSimple = vi.fn()
  return {
    boundRequestVersion: 1,
    find: vi.fn(() => model),
    prepareBoundRequest: vi.fn(async () => ({
      binding,
      authIdentityFence: 'synthetic-login-epoch',
      streamSimple,
    })),
    streamSimple,
  }
}
it('fails stock pi explicitly before credentials or streaming', async () => {
  await expect(
    prepareLearningAuth({ find: () => model }, selection, new AbortController().signal),
  ).rejects.toThrow('boundRequestVersion')
})
it.each(['oauth', 'api-key'] as const)(
  'binds a native %s current slot with no secret-returning API or fallback',
  async (authMode) => {
    const r = registry()
    r.prepareBoundRequest.mockResolvedValue({
      binding: { ...binding, authMode },
      authIdentityFence: 'synthetic-login-epoch',
      streamSimple: r.streamSimple,
    })
    const result = await prepareLearningAuth(r, selection, new AbortController().signal)
    expect(result.binding.authMode).toBe(authMode)
    expect(result.maxOutputTokens).toBe(16000)
    expect(r.prepareBoundRequest).toHaveBeenCalledWith(
      model,
      {
        expected: { provider: selection.provider, modelId: selection.modelId },
        signal: expect.any(AbortSignal),
        allowVirtual: false,
        allowFallback: false,
        allowCustom: false,
      },
    )
    expect(r.streamSimple).not.toHaveBeenCalled()
  },
)
it('rejects model selection fallback, foreign bindings, and malformed endpoint before a stream', async () => {
  const r = registry()
  r.find.mockReturnValue({ ...model, id: 'fallback' })
  await expect(prepareLearningAuth(r, selection, new AbortController().signal)).rejects.toThrow()
  r.find.mockReturnValue(model)
  r.prepareBoundRequest.mockResolvedValue({
    binding: { ...binding, modelId: 'foreign' },
    authIdentityFence: 'synthetic-login-epoch',
    streamSimple: r.streamSimple,
  })
  await expect(prepareLearningAuth(r, selection, new AbortController().signal)).rejects.toThrow()
  expect(r.streamSimple).not.toHaveBeenCalled()
})
it('requires explicit Claude slot and the final qualified version/capability', async () => {
  const r = registry()
  const claude = { ...selection, provider: 'pi-claude-cli' }
  await expect(prepareLearningAuth(r, claude, new AbortController().signal)).rejects.toThrow(
    'explicit',
  )
  await expect(
    prepareLearningAuth(r, { ...claude, accountId: 'assigned' }, new AbortController().signal),
  ).rejects.toThrow()
  expect(r.prepareBoundRequest).not.toHaveBeenCalled()
})

it('rejects an auth identity replacement even when the selected stable slot is unchanged', async () => {
  const r = registry()
  await expect(
    prepareLearningAuth(
      r,
      { ...selection, accountId: binding.accountId, authIdentityFence: 'earlier-login' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('identity')
  expect(r.streamSimple).not.toHaveBeenCalled()
})
it('pins the real model object and invokes a native bound stream at most once without credentials or overrides', async () => {
  const r = registry(),
    prepared = await prepareLearningAuth(r, selection, new AbortController().signal)
  const context = { messages: [] },
    options = {
      signal: new AbortController().signal,
      maxRetries: 0 as const,
      maxTokens: 1000,
      reasoning: 'high',
    }
  expect(() => prepared.streamSimple({ ...model }, context, options)).toThrow()
  prepared.streamSimple(prepared.model, context, options)
  expect(r.streamSimple).toHaveBeenCalledExactlyOnceWith(context, options)
  expect(() => prepared.streamSimple(prepared.model, context, options)).toThrow('one-shot')
})
it('refuses a virtual route before bound-request preparation', async () => {
  const r = registry()
  r.find.mockReturnValue({ ...model, api: 'pi-virtual' })
  await expect(prepareLearningAuth(r, selection, new AbortController().signal)).rejects.toThrow()
  expect(r.prepareBoundRequest).not.toHaveBeenCalled()
})
it.each([
  [{ type: 'thinking', thinking: 'supplied historical plaintext', thinkingSignature: 'opaque' }],
  [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque-only' }],
])(
  'qualifies final Claude 0.11 opt-in while passing supplied thinking through without invented text',
  async (blocks) => {
    const cliModel = { ...model, provider: 'pi-claude-cli', api: 'claude-cli' }
    const stream = vi.fn()
    const r = {
      boundRequestVersion: 1,
      find: () => cliModel,
      prepareBoundRequest: vi.fn(async () => ({
        binding: {
          ...binding,
          provider: cliModel.provider,
          api: cliModel.api,
          authMode: 'cli' as const,
          accountId: 'explicit-cli',
        },
        authIdentityFence: 'cli-login-epoch',
        streamSimple: stream,
      })),
    }
    const prepared = await prepareLearningAuth(
      r,
      {
        ...selection,
        provider: cliModel.provider,
        accountId: 'explicit-cli',
        claudeVersion: '0.11.0',
      },
      new AbortController().signal,
    )
    const context = { messages: [{ role: 'assistant', content: blocks }] }
    const options = {
      signal: new AbortController().signal,
      maxRetries: 0 as const,
      maxTokens: 1000,
      reasoning: 'high',
      metadata: { piSingleResponse: 1 as const },
    }
    prepared.streamSimple(prepared.model, context, options)
    const { metadata, ...coreOptions } = options
    expect(stream).toHaveBeenCalledExactlyOnceWith(context, coreOptions)
    expect(options.metadata).toBe(metadata)
    expect(stream.mock.calls[0]![1]).not.toHaveProperty('metadata')
    expect(r.prepareBoundRequest).toHaveBeenCalledWith(
      cliModel,
      expect.objectContaining({
        routePolicy: 'claude-single-response',
        allowCustom: true,
        allowFallback: false,
      }),
    )
    expect(JSON.stringify(stream.mock.calls[0]![0])).toBe(JSON.stringify(context))
  },
)
