import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionProviderStatus } from '@shared/models'

const invoke = vi.fn()

const MODEL = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  provider: 'anthropic',
  reasoning: true,
}

beforeEach(async () => {
  invoke.mockReset()
  vi.stubGlobal('window', { pidex: { invoke } })
  const { useModelCatalogueStore } = await import('./modelCatalogue')
  useModelCatalogueStore.setState({
    status: 'idle',
    models: [],
    source: 'pi',
    providers: [],
    error: null,
  })
})

/** Default happy path: pi answered, one model, no signed-in provider. */
function stubOk(models: unknown[] = [MODEL], source: 'pi' | 'config' = 'pi'): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'pi:catalogueModels') return { models, source }
    if (channel === 'pi:subscriptionAuth') return []
    throw new Error(`unexpected channel ${channel}`)
  })
}

describe('useModelCatalogueStore', () => {
  it('starts idle so a picker can tell "not asked" from "none"', async () => {
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    expect(useModelCatalogueStore.getState().status).toBe('idle')
  })

  it('reaches ready with the fetched models', async () => {
    stubOk()
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('ready')
    expect(useModelCatalogueStore.getState().models).toEqual([MODEL])
  })

  it('fetches once however many callers hydrate', async () => {
    stubOk()
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await Promise.all([
      useModelCatalogueStore.getState().hydrate(),
      useModelCatalogueStore.getState().hydrate(),
      useModelCatalogueStore.getState().hydrate(),
    ])
    const catalogueCalls = invoke.mock.calls.filter((c) => c[0] === 'pi:catalogueModels')
    expect(catalogueCalls).toHaveLength(1)
  })

  it('does not re-fetch once ready on pi’s own answer', async () => {
    stubOk()
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    await useModelCatalogueStore.getState().hydrate()
    expect(invoke.mock.calls.filter((c) => c[0] === 'pi:catalogueModels')).toHaveLength(1)
  })

  // The defect this store shipped with: a boot-time fetch that came back with
  // the models.json fallback set status to 'ready', hydrate() short-circuited
  // forever after, and nothing else called refresh(). The wrong model list
  // then survived until the app was quit.
  it('re-asks pi while the list in hand is only the models.json fallback', async () => {
    stubOk([MODEL], 'config')
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('ready')
    expect(useModelCatalogueStore.getState().source).toBe('config')

    await useModelCatalogueStore.getState().hydrate()
    expect(invoke.mock.calls.filter((c) => c[0] === 'pi:catalogueModels')).toHaveLength(2)
  })

  it('stops re-asking once pi finally answers', async () => {
    stubOk([MODEL], 'config')
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    stubOk()
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().source).toBe('pi')
    await useModelCatalogueStore.getState().hydrate()
    expect(invoke.mock.calls.filter((c) => c[0] === 'pi:catalogueModels')).toHaveLength(2)
  })

  it('re-fetches on an explicit refresh', async () => {
    stubOk()
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    await useModelCatalogueStore.getState().refresh()
    expect(invoke.mock.calls.filter((c) => c[0] === 'pi:catalogueModels')).toHaveLength(2)
  })

  it('goes to error when the catalogue call fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pi:catalogueModels') throw new Error('pi missing')
      return []
    })
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('error')
    expect(useModelCatalogueStore.getState().error).toBe('pi missing')
  })

  it('still reaches ready when only the auth check fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pi:catalogueModels') return { models: [MODEL], source: 'pi' }
      throw new Error('auth check blew up')
    })
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('ready')
    expect(useModelCatalogueStore.getState().providers).toEqual([])
  })

  it('retries after an error', async () => {
    invoke.mockImplementationOnce(async () => {
      throw new Error('pi missing')
    })
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('error')
    stubOk()
    await useModelCatalogueStore.getState().hydrate()
    expect(useModelCatalogueStore.getState().status).toBe('ready')
  })

  it('matches a model on provider AND id, never id alone', async () => {
    stubOk([MODEL, { ...MODEL, provider: 'claude-cli' }])
    const { useModelCatalogueStore } = await import('./modelCatalogue')
    await useModelCatalogueStore.getState().hydrate()
    const found = useModelCatalogueStore.getState().find('claude-cli', 'claude-opus-5')
    expect(found?.provider).toBe('claude-cli')
    expect(useModelCatalogueStore.getState().find('bedrock', 'claude-opus-5')).toBeUndefined()
  })
})

describe('modelChipLabel', () => {
  it('never shows a raw id while the catalogue is still loading', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    const chip = modelChipLabel('loading', undefined, 'us.anthropic.claude-opus-5-v1:0')
    expect(chip.loading).toBe(true)
    expect(chip.text).not.toContain('us.anthropic')
  })

  it('treats idle the same as loading — nothing has been asked yet', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    expect(modelChipLabel('idle', undefined, 'some-id').loading).toBe(true)
  })

  it('shows the display name once the model is known', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    const chip = modelChipLabel('ready', MODEL, 'claude-opus-5')
    expect(chip).toEqual({
      text: 'Claude Opus 5',
      loading: false,
      unavailable: false,
      degraded: false,
    })
  })

  it('marks a configured model the catalogue does not have', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    const chip = modelChipLabel('ready', undefined, 'gone-model')
    expect(chip).toEqual({
      text: 'gone-model',
      loading: false,
      unavailable: true,
      degraded: false,
    })
  })

  // models.json not listing a model says nothing about pi's catalogue, which
  // is where a provider like pi-claude-cli actually lives. Calling that
  // "unavailable" blamed the user's default for pi being unreachable.
  it('does not call a model unavailable when only the fallback list is in hand', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    const chip = modelChipLabel('ready', undefined, 'claude-opus-5', 'config')
    expect(chip).toEqual({
      text: 'claude-opus-5',
      loading: false,
      unavailable: false,
      degraded: true,
    })
  })

  it('falls back to a prompt when nothing is configured at all', async () => {
    const { modelChipLabel } = await import('./modelCatalogue')
    expect(modelChipLabel('ready', undefined, null).text).toBe('Select model')
  })
})

describe('catalogueEmptyText', () => {
  const provider = (name: string, status: 'ready' | 'not_ready'): SubscriptionProviderStatus =>
    ({ id: name, name, status }) as SubscriptionProviderStatus

  it('points at Accounts when nothing is signed in', async () => {
    const { catalogueEmptyText } = await import('./modelCatalogue')
    expect(catalogueEmptyText('ready', [provider('Anthropic', 'not_ready')])).toContain('Accounts')
  })

  it('names the signed-in provider when the list is still empty', async () => {
    const { catalogueEmptyText } = await import('./modelCatalogue')
    const text = catalogueEmptyText('ready', [provider('Anthropic', 'ready')])
    expect(text).toContain('Anthropic')
    expect(text).toContain('models.json')
  })

  it('says so when the fetch itself failed', async () => {
    const { catalogueEmptyText } = await import('./modelCatalogue')
    expect(catalogueEmptyText('error', [])).toContain('Could not read')
  })
})
