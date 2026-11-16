import { expect, it } from 'vitest'
import { defaultRemoteModel, remoteModelExplanation, remoteStartThinking } from './remoteModel'
const models = [
  { id: 'not-ready', name: 'Unavailable', provider: 'offline', reasoning: false },
  { id: 'first', name: 'First', provider: 'ready', reasoning: false },
  { id: 'last', name: 'Last', provider: 'ready', reasoning: true },
  { id: 'host', name: 'Host default', provider: 'ready', reasoning: true },
]
const providers = [
  { id: 'offline', name: 'Offline', status: 'not_ready' as const },
  { id: 'ready', name: 'Ready', status: 'ready' as const },
]
const unusable = { provider: 'offline', id: 'not-ready' }
const unlisted = { provider: 'ready', id: 'gone' }
const pick = (preferences: Parameters<typeof defaultRemoteModel>[2]) =>
  defaultRemoteModel(models, providers, preferences)?.id

it('prefers the last usable choice over the Host default and the Desktop default', () => {
  expect(
    pick({
      last: { model: { provider: 'ready', id: 'last' } },
      host: { model: { provider: 'ready', id: 'host' } },
      desktop: { model: { provider: 'ready', id: 'first' } },
    }),
  ).toBe('last')
})
it('prefers the Host default over the Desktop default once the last choice is unusable', () => {
  for (const last of [undefined, { model: unusable }, { model: unlisted }])
    expect(
      pick({
        last,
        host: { model: { provider: 'ready', id: 'host' } },
        desktop: { model: { provider: 'ready', id: 'last' } },
      }),
    ).toBe('host')
})
it('uses the Desktop default only when the Host default is missing or unusable', () => {
  for (const host of [undefined, {}, { model: unusable }, { model: unlisted }])
    expect(
      pick({
        last: { model: unusable },
        host,
        desktop: { model: { provider: 'ready', id: 'last' } },
      }),
    ).toBe('last')
})
it('falls back to the first signed-in provider model, never an unavailable model', () => {
  expect(pick({ host: { model: unusable }, desktop: { model: unusable } })).toBe('first')
  expect(pick(undefined)).toBe('first')
})
it('has no model when nothing is usable', () => {
  expect(
    defaultRemoteModel(
      models,
      providers.map((p) => ({ ...p, status: 'not_ready' })),
      { host: { model: { provider: 'ready', id: 'host' } } },
    ),
  ).toBeUndefined()
})

it('names the rule that chose the model', () => {
  const first = models[1]!
  const host = models[3]!
  expect(remoteModelExplanation(host, { last: { model: host }, host: { model: host } })).toBe(
    'Using your last selected model for this machine.',
  )
  expect(remoteModelExplanation(host, { host: { model: host } })).toBe(
    'Using this Host’s default model.',
  )
  expect(remoteModelExplanation(first, { desktop: { model: first } })).toContain('Desktop default')
  expect(remoteModelExplanation(first)).toBe(
    'This Host reports no default model. Using the first available model; choose another if needed.',
  )
  expect(remoteModelExplanation(first, { host: { model: unusable } })).toBe(
    'This Host’s default model is not available. Using the first available model; choose another if needed.',
  )
})

it('starts on the thinking level by the same order, clamped to the model', () => {
  const reasoning = models[3]!
  expect(
    remoteStartThinking(reasoning, {
      last: { thinking: 'low' },
      host: { thinking: 'high' },
      desktop: { thinking: 'minimal' },
    }),
  ).toBe('low')
  expect(
    remoteStartThinking(reasoning, {
      host: { thinking: 'high' },
      desktop: { thinking: 'minimal' },
    }),
  ).toBe('high')
  expect(remoteStartThinking(reasoning, { host: {}, desktop: { thinking: 'minimal' } })).toBe(
    'minimal',
  )
  expect(remoteStartThinking(reasoning, {})).toBe('off')
  expect(remoteStartThinking(models[1]!, { host: { thinking: 'high' } })).toBe('off')
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
