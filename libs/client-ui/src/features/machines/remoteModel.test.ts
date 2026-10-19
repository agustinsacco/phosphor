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
