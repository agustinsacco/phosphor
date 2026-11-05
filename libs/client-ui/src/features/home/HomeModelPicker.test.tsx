// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelCatalogueStore, type CatalogueModel } from '@/stores/modelCatalogue'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { localMachineLabel } from '@/lib/localMachine'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { HomeModelPicker } from './HomeModelPicker'

/** This Mac's start picker: pi's catalogue, pi's global defaults, a draft's own model. */

const MODELS: CatalogueModel[] = [
  { id: 'one', name: 'Model One', provider: 'p', reasoning: true },
  { id: 'two', name: 'Model Two', provider: 'p', reasoning: false },
]

let root: Root
let el: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>

function catalogue(state: Partial<ReturnType<typeof useModelCatalogueStore.getState>>): void {
  useModelCatalogueStore.setState({
    status: 'ready',
    source: 'pi',
    models: MODELS,
    providers: [],
    hydrate: async () => undefined,
    refresh,
    ...state,
  })
}

async function draw(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(node))
}

const chip = (): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-testid="home-model-picker"]')!
const thinkingChip = (): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-testid="home-thinking-picker"]')
const actions = (): HTMLButtonElement[] =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.dataset.testid)
const patches = (): unknown[] =>
  invoke.mock.calls.filter(([channel]) => channel === 'pi:patchAgentSettings').map(([, ...a]) => a)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  refresh = vi.fn(async () => undefined)
  invoke = vi.fn(async (channel: string) =>
    channel === 'pi:agentSettings'
      ? { defaultProvider: 'p', defaultModel: 'one', defaultThinkingLevel: 'high' }
      : channel === 'app:getPrefs'
        ? {}
        : undefined,
  )
  vi.stubGlobal('phosphor', { invoke })
  catalogue({})
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

describe('HomeModelPicker', () => {
  it("shows pi's default model and thinking level", async () => {
    await draw(<HomeModelPicker />)
    expect(chip().textContent).toBe('Model One')
    expect(chip().disabled).toBe(false)
    expect(thinkingChip()?.textContent).toBe('High')
  })

  it("prefers the draft's model over pi's default", async () => {
    await draw(<HomeModelPicker override={{ provider: 'p', id: 'two' }} />)
    expect(chip().textContent).toBe('Model Two')
    // A model without reasoning has one level: no thinking chip.
    expect(thinkingChip()).toBeNull()
  })

  it("writes a picked model to pi's defaults and tells the draft", async () => {
    const onPick = vi.fn()
    await draw(<HomeModelPicker onPick={onPick} />)
    act(() => chip().click())
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="model-row"]')].find((r) =>
      r.textContent?.includes('Model Two'),
    )!
    act(() => row.click())
    expect(onPick).toHaveBeenCalledWith({ provider: 'p', id: 'two' })
    expect(patches()).toEqual([
      ['global', undefined, { defaultProvider: 'p', defaultModel: 'two' }],
    ])
    expect(chip().textContent).toBe('Model Two')
  })

  it("writes a picked thinking level to pi's defaults", async () => {
    await draw(<HomeModelPicker />)
    act(() => thinkingChip()!.click())
    const low = [...document.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent === 'Low',
    )!
    act(() => low.click())
    expect(patches()).toEqual([['global', undefined, { defaultThinkingLevel: 'low' }]])
    expect(thinkingChip()?.textContent).toBe('Low')
  })

  it('holds the chip until the catalogue lands', async () => {
    catalogue({ status: 'loading', models: [] })
    await draw(<HomeModelPicker />)
    expect(chip().disabled).toBe(true)
    expect(chip().dataset.loading).toBe('true')
  })

  it('names a degraded catalogue and asks pi again when opened', async () => {
    catalogue({ source: 'config', models: [MODELS[1]!] })
    await draw(<HomeModelPicker />)
    expect(chip().textContent).toBe('one · pi unreachable')
    act(() => chip().click())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('showing only what models.json declares')
  })

  it('warns about a default pi no longer offers', async () => {
    catalogue({ models: [MODELS[1]!] })
    await draw(<HomeModelPicker />)
    expect(chip().textContent).toBe('one · unavailable')
    expect(chip().getAttribute('data-tooltip')).toBe("one is not in pi's catalogue")
  })

  it('offers no source action while the catalogue has models', async () => {
    await draw(<HomeModelPicker />)
    expect(actions()).toEqual([])
  })

  it('offers Retry models when the catalogue failed, as a Host does', async () => {
    catalogue({ status: 'error', models: [] })
    await draw(<HomeModelPicker />)
    expect(actions().map((b) => b.textContent)).toEqual(['Retry models'])
    act(() => actions()[0]!.click())
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('offers Sign in on This Mac when pi has no models: Settings → Accounts', async () => {
    catalogue({ models: [] })
    const navigate = vi.fn<(next: Location) => void>()
    await draw(
      <NavigationProvider value={{ location: { to: 'home' } as never, navigate }}>
        <HomeModelPicker />
      </NavigationProvider>,
    )
    expect(actions().map((b) => b.textContent)).toEqual([`Sign in on ${localMachineLabel()}`])
    act(() => actions()[0]!.click())
    expect(useSettingsUiStore.getState().tab).toBe('accounts')
    expect(navigate).toHaveBeenCalledWith({ to: 'page', page: 'settings', machine: 'local' })
  })
})
