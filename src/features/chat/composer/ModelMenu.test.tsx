// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelMenu, type ModelMenuEntry } from './ModelMenu'
import { useModelPicksStore } from '@/stores/modelPicks'

// jsdom has no layout engine, so MenuRow's scroll-into-view call is a no-op here.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const invoke = vi.fn(async (channel: string) => {
  if (channel === 'app:getPrefs') {
    return { modelPicks: { starred: [], recent: [], groupMode: 'family' } }
  }
  return undefined
})

beforeEach(() => {
  invoke.mockClear()
  // The menu is a projection of persisted picks; give it a main process.
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { invoke }
  useModelPicksStore.setState({
    starred: [],
    recent: [],
    groupMode: 'family',
    hydrated: true,
  })
})

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

const bedrock = (id: string, name: string): ModelMenuEntry => ({
  id,
  name,
  provider: 'amazon-bedrock',
})

/** The real shape from pi's catalogue: one bare id plus three profiles. */
const FABLE_MODELS: ModelMenuEntry[] = [
  bedrock('anthropic.claude-fable-5', 'Claude Fable 5'),
  bedrock('eu.anthropic.claude-fable-5', 'Claude Fable 5 (EU)'),
  bedrock('us.anthropic.claude-fable-5', 'Claude Fable 5 (US)'),
  bedrock('global.anthropic.claude-fable-5', 'Claude Fable 5 (Global)'),
]

/** One model, three routes — the case the whole menu is shaped around. */
const MULTI_PROVIDER: ModelMenuEntry[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', contextWindow: 200_000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'pi-claude-cli' },
  {
    id: 'us.anthropic.claude-opus-5',
    name: 'Claude Opus 5 (US)',
    provider: 'amazon-bedrock',
  },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai' },
]

/** Model rows only — the star toggles and filter chips are buttons too. */
function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll('[data-testid="model-row"]')] as HTMLButtonElement[]
}

/** A row by the `provider/id` it carries in its title. */
function rowFor(key: string): HTMLButtonElement {
  const found = rows().find(
    (r) => r.title.startsWith(key) || r.title.startsWith(key.split('/')[1]!),
  )
  if (!found) throw new Error(`no row for ${key}: ${rows().map((r) => r.title)}`)
  return found
}

function headers(): string[] {
  return [...document.querySelectorAll('[data-testid="model-list"] > div')]
    .filter((el) => !el.querySelector('[data-testid="model-row"]'))
    .map((el) => el.textContent ?? '')
}

function searchField(): HTMLInputElement {
  const el = document.querySelector('[data-testid="model-search"]')
  if (!el) throw new Error('no search field')
  return el as HTMLInputElement
}

/**
 * Type into the search field.
 *
 * Assigning `.value` directly is NOT enough: React keeps a value tracker per
 * input and skips onChange when the tracked value already matches, so a direct
 * assignment plus a synthetic `input` event silently does nothing — the list
 * stays unfiltered and every search assertion passes vacuously. Going through
 * the prototype's setter is what updates the tracker.
 */
function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    const field = searchField()
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    searchField().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

function mount(
  models: ModelMenuEntry[],
  onPick = vi.fn(),
  isCurrent: (m: ModelMenuEntry) => boolean = () => false,
): { onPick: ReturnType<typeof vi.fn> } {
  render(
    <ModelMenu
      models={models}
      isCurrent={isCurrent}
      onPick={onPick}
      onClose={vi.fn()}
      emptyText="none"
    />,
  )
  return { onPick }
}

describe('ModelMenu availability', () => {
  it('disables the bare Bedrock id and explains why', () => {
    mount(FABLE_MODELS)
    const bare = rowFor('amazon-bedrock/anthropic.claude-fable-5')
    expect(bare.disabled).toBe(true)
    expect(bare.textContent).toMatch(/inference profile/i)
  })

  it('leaves the region-prefixed profiles selectable', () => {
    mount(FABLE_MODELS)
    for (const id of [
      'eu.anthropic.claude-fable-5',
      'us.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5',
    ]) {
      expect(rowFor(`amazon-bedrock/${id}`).disabled).toBe(false)
    }
  })

  it('does not pick a disabled model on click', () => {
    const { onPick } = mount(FABLE_MODELS)
    act(() => {
      rowFor('amazon-bedrock/anthropic.claude-fable-5').click()
    })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('picks a working profile on click', () => {
    const { onPick } = mount(FABLE_MODELS)
    act(() => {
      rowFor('amazon-bedrock/global.anthropic.claude-fable-5').click()
    })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'global.anthropic.claude-fable-5' }),
    )
  })

  it('skips disabled rows when arrowing, so Enter never lands on one', () => {
    const { onPick } = mount(FABLE_MODELS)
    // The bare id sorts first; the initial highlight must already have moved
    // past it, so Enter with no arrowing picks a real model.
    press('Enter')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0]?.id).not.toBe('anthropic.claude-fable-5')
  })

  it('never highlights the disabled row while cycling with ArrowDown', () => {
    const { onPick } = mount(FABLE_MODELS)
    // Three selectable rows: a full cycle plus one must stay on real models.
    for (let i = 0; i < 4; i++) {
      press('ArrowDown')
      press('Enter')
    }
    expect(onPick).toHaveBeenCalledTimes(4)
    for (const call of onPick.mock.calls) {
      expect(call[0].id).not.toBe('anthropic.claude-fable-5')
    }
  })

  it('wraps backwards past the disabled row with ArrowUp', () => {
    const { onPick } = mount(FABLE_MODELS)
    press('ArrowUp')
    press('Enter')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0]?.id).not.toBe('anthropic.claude-fable-5')
  })

  it('leaves a catalogue with no profile siblings fully selectable', () => {
    mount([
      bedrock('amazon.nova-pro-v1:0', 'Nova Pro'),
      bedrock('amazon.nova-lite-v1:0', 'Nova Lite'),
    ])
    expect(rows().every((r) => !r.disabled)).toBe(true)
  })

  it('still shows the blocked row when it is the only search match', () => {
    // Hiding it would make "where did Fable go?" unanswerable; it stays, dimmed.
    mount(FABLE_MODELS)
    type('anthropic.claude-fable-5')
    expect(rowFor('amazon-bedrock/anthropic.claude-fable-5').disabled).toBe(true)
  })
})

describe('ModelMenu search', () => {
  it('finds every route to a model from its name alone', () => {
    mount(MULTI_PROVIDER)
    type('opus 5')
    expect(rows()).toHaveLength(3)
    expect(rows().every((r) => r.title.includes('opus'))).toBe(true)
  })

  it('narrows to one provider without knowing how its ids are spelled', () => {
    mount(MULTI_PROVIDER)
    type('opus bedrock')
    expect(rows().map((r) => r.title)).toEqual(['amazon-bedrock/us.anthropic.claude-opus-5'])
  })

  it('does not care about term order', () => {
    mount(MULTI_PROVIDER)
    type('bedrock opus')
    expect(rows().map((r) => r.title)).toEqual(['amazon-bedrock/us.anthropic.claude-opus-5'])
  })

  it('reports when nothing matches', () => {
    mount(MULTI_PROVIDER)
    type('llama')
    expect(rows()).toHaveLength(0)
    expect(document.body.textContent).toMatch(/No models match/)
  })

  it('highlights the matched text', () => {
    mount(MULTI_PROVIDER)
    type('opus')
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent?.toLowerCase())
    expect(marks).toContain('opus')
  })
})

describe('ModelMenu grouping', () => {
  it('collapses every route to one model under a single header', () => {
    mount(MULTI_PROVIDER)
    type('opus')
    // One header for the family, and each row leads with its provider — the
    // only thing that differs between them.
    expect(headers().filter((h) => h.includes('Claude Opus 5'))).toHaveLength(1)
    expect(rowFor('anthropic/claude-opus-5').textContent).toMatch(/^anthropic/)
    expect(rowFor('pi-claude-cli/claude-opus-5').textContent).toMatch(/^pi-claude-cli/)
  })

  it('leads with the model name for a family with only one route', () => {
    mount(MULTI_PROVIDER)
    type('gpt')
    expect(rowFor('openai/gpt-5').textContent).toMatch(/^GPT-5/)
  })

  it('groups by provider when the mode is switched', () => {
    mount(MULTI_PROVIDER)
    act(() => {
      ;([...document.querySelectorAll('button')] as HTMLButtonElement[])
        .find((b) => b.textContent === 'Provider')!
        .click()
    })
    expect(useModelPicksStore.getState().groupMode).toBe('provider')
    expect(headers().some((h) => h.includes('pi-claude-cli'))).toBe(true)
  })

  it('shows the provider and id on every row, so identical names stay distinguishable', () => {
    mount(MULTI_PROVIDER)
    const text = rowFor('pi-claude-cli/claude-opus-5').textContent ?? ''
    expect(text).toContain('pi-claude-cli')
    expect(text).toContain('claude-opus-5')
  })

  it('renders the context window when the catalogue supplied one', () => {
    mount(MULTI_PROVIDER)
    expect(rowFor('anthropic/claude-opus-5').textContent).toMatch(/200k ctx/)
    // …and says nothing at all when it did not.
    expect(rowFor('pi-claude-cli/claude-opus-5').textContent).not.toMatch(/ctx/)
  })
})

describe('ModelMenu provider filter', () => {
  it('offers one chip per provider and filters to it', () => {
    mount(MULTI_PROVIDER)
    act(() => {
      ;([...document.querySelectorAll('button')] as HTMLButtonElement[])
        .find((b) => b.textContent?.startsWith('openai'))!
        .click()
    })
    expect(rows().map((r) => r.title)).toEqual(['openai/gpt-5'])
  })

  it('hides the chip row when every model comes from one provider', () => {
    mount(FABLE_MODELS)
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'All')).toBe(
      false,
    )
  })
})

describe('ModelMenu stars and recents', () => {
  it('stars the highlighted row with the keyboard and persists it', () => {
    mount(MULTI_PROVIDER)
    type('opus bedrock')
    press('d', { metaKey: true })
    expect(useModelPicksStore.getState().starred).toEqual([
      'amazon-bedrock/us.anthropic.claude-opus-5',
    ])
    expect(invoke).toHaveBeenCalledWith(
      'app:setModelPicks',
      expect.objectContaining({ starred: ['amazon-bedrock/us.anthropic.claude-opus-5'] }),
    )
  })

  it('⌘D never doubles as a pick', () => {
    const { onPick } = mount(MULTI_PROVIDER)
    press('d', { metaKey: true })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('lists starred and recent models above the catalogue while idle', () => {
    useModelPicksStore.setState({
      starred: ['pi-claude-cli/claude-opus-5'],
      recent: ['openai/gpt-5'],
    })
    mount(MULTI_PROVIDER)
    expect(headers()[0]).toMatch(/Starred/)
    expect(headers()[1]).toMatch(/Recent/)
  })

  it('drops the shortcut sections during a search, so no model appears twice', () => {
    useModelPicksStore.setState({ starred: ['pi-claude-cli/claude-opus-5'], recent: [] })
    mount(MULTI_PROVIDER)
    type('opus')
    expect(headers().some((h) => /Starred/.test(h))).toBe(false)
    expect(rows().filter((r) => r.title === 'pi-claude-cli/claude-opus-5')).toHaveLength(1)
  })

  it('does not repeat a starred model in the recent list', () => {
    useModelPicksStore.setState({
      starred: ['openai/gpt-5'],
      recent: ['openai/gpt-5', 'anthropic/claude-opus-5'],
    })
    mount(MULTI_PROVIDER)
    // GPT-5 is starred, so the Recent section holds only the other entry —
    // 4 catalogue rows + 1 starred + 1 recent.
    expect(rows()).toHaveLength(6)
    expect(rows().filter((r) => r.title === 'openai/gpt-5')).toHaveLength(2)
  })

  it('records a pick as the most recent model', () => {
    const { onPick } = mount(MULTI_PROVIDER)
    act(() => {
      rowFor('openai/gpt-5').click()
    })
    expect(onPick).toHaveBeenCalled()
    expect(useModelPicksStore.getState().recent[0]).toBe('openai/gpt-5')
  })

  it('drops a stale starred key rather than inventing a row for it', () => {
    // A model can disappear from the catalogue (provider package removed, key
    // revoked). The section must shrink, never render a placeholder.
    useModelPicksStore.setState({ starred: ['gone/model-x'], recent: [] })
    mount(MULTI_PROVIDER)
    expect(headers().some((h) => /Starred/.test(h))).toBe(false)
  })
})
