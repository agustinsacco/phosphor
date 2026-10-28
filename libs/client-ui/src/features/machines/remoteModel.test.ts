import { expect, it } from 'vitest'
import { defaultRemoteModel } from './remoteModel'
const models = [
  { id: 'not-ready', name: 'Unavailable', provider: 'offline', reasoning: false },
  { id: 'first', name: 'First', provider: 'ready', reasoning: false },
  { id: 'last', name: 'Last', provider: 'ready', reasoning: true },
]
const providers = [
  { id: 'offline', name: 'Offline', status: 'not_ready' as const },
  { id: 'ready', name: 'Ready', status: 'ready' as const },
]
it('prefers the Host last-used usable model over the Desktop default', () => {
  expect(
    defaultRemoteModel(
      models,
      providers,
      { provider: 'ready', id: 'last' },
      { provider: 'ready', id: 'first' },
    )?.id,
  ).toBe('last')
})
it('uses the Desktop default only when the Host reports it usable', () => {
  expect(
    defaultRemoteModel(
      models,
      providers,
      { provider: 'offline', id: 'not-ready' },
      { provider: 'ready', id: 'last' },
    )?.id,
  ).toBe('last')
})
it('falls back to the first signed-in provider model, never an unavailable model', () => {
  expect(
    defaultRemoteModel(models, providers, undefined, { provider: 'offline', id: 'not-ready' })?.id,
  ).toBe('first')
})
it('has no model when nothing is usable', () => {
  expect(
    defaultRemoteModel(
      models,
      providers.map((p) => ({ ...p, status: 'not_ready' })),
    ),
  ).toBeUndefined()
})

it('discloses fallback order rather than claiming a configured Host default', async () => {
  const { remoteModelExplanation } = await import('./remoteModel')
  const model = models[1]!
  expect(remoteModelExplanation(model)).toContain('Host does not expose a default model')
  expect(remoteModelExplanation(model, model)).toContain('last selected')
  expect(remoteModelExplanation(model, undefined, model)).toContain('Desktop default')
})

it('blocks only signed-out providers and profile-only Bedrock ids, with the reason', async () => {
  const { hostModelUnavailability } = await import('./remoteModel')
  const listed = [
    ...models,
    { id: 'key', name: 'Key', provider: 'api-key', reasoning: false },
    { id: 'anthropic.claude-x', name: 'X', provider: 'amazon-bedrock', reasoning: false },
    { id: 'us.anthropic.claude-x', name: 'X (US)', provider: 'amazon-bedrock', reasoning: false },
  ]
  const blocked = hostModelUnavailability(listed, providers, 'bee1')
  expect([...blocked.keys()].sort()).toEqual([
    'amazon-bedrock/anthropic.claude-x',
    'offline/not-ready',
  ])
  expect(blocked.get('offline/not-ready')?.detail).toBe('Sign in to Offline on bee1')
})
it('falls back to a model pi lists for a provider the sign-in check does not cover', () => {
  const listed = [{ id: 'key', name: 'Key', provider: 'api-key', reasoning: false }, ...models]
  expect(defaultRemoteModel(listed, providers)?.id).toBe('first')
  expect(defaultRemoteModel(listed, [])?.id).toBe('key')
  expect(defaultRemoteModel(listed, [{ id: 'api-key', name: 'Key', status: 'unknown' }])?.id).toBe(
    'key',
  )
})
