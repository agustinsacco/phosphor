// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainStatus } from '@shared/brain'
import { mockBrainStatus } from '@/features/brain/mockBrainData'
import { useBrain } from '@/features/brain/useBrain'
import { desktopPlatform, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { BrainTab } from './BrainTab'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useModelPicksStore } from '@/stores/modelPicks'

let root: Root
let container: HTMLDivElement
let status: BrainStatus
const invoke = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useModelCatalogueStore.setState({
    status: 'ready',
    source: 'pi',
    models: [
      {
        id: 'reader',
        name: 'Harbor Reader',
        provider: 'harbor',
        reasoning: true,
        cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
  useModelPicksStore.setState({ hydrated: true, starred: [], recent: [] })
  status = mockBrainStatus()
  useBrain.setState({ status: null, error: '', saving: false })
  invoke.mockReset().mockImplementation(async (channel: string, prefs: unknown) => {
    if (channel === 'brain:setPrefs') status = { ...status, prefs: prefs as BrainStatus['prefs'] }
    return structuredClone(status)
  })
  vi.stubGlobal('phosphor', { invoke })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async (): Promise<void> => {
  await act(async () =>
    root.render(
      <PlatformProvider value={desktopPlatform(false, true)}>
        <BrainTab />
      </PlatformProvider>,
    ),
  )
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

it('saves exactly once per toggle and shows enabled rows immediately', async () => {
  await render()
  expect(container.textContent).not.toContain('Recall in lanes')
  const terms = container.querySelector('a')!
  expect(terms.href).toBe('https://ai.google.dev/gemma/terms')
  await click('Brain')
  expect(invoke.mock.calls.filter(([channel]) => channel === 'brain:setPrefs')).toEqual([
    ['brain:setPrefs', { ...DEFAULT_BRAIN_PREFS, enabled: true }],
  ])
  expect(container.textContent).toContain('Recall in lanes')
  expect(container.textContent).toContain('Brain Agent checks new knowledge on its own')
  expect(container.textContent).not.toContain('Review before saving')
  expect(container.textContent).toContain('Open Brain')
  await click('Recall in lanes')
  expect(invoke).toHaveBeenLastCalledWith('brain:setPrefs', {
    enabled: true,
    recall: false,
    agentAuto: true,
    model: null,
    neverRead: DEFAULT_BRAIN_PREFS.neverRead,
  })
  await click('Brain Agent checks new knowledge on its own')
  expect(invoke).toHaveBeenLastCalledWith('brain:setPrefs', {
    enabled: true,
    recall: false,
    agentAuto: false,
    model: null,
    neverRead: DEFAULT_BRAIN_PREFS.neverRead,
  })
  expect(
    [...container.querySelectorAll('[role=switch]')].map((s) => s.getAttribute('aria-label')),
  ).not.toContain('Review before saving')
})

it('sends lane flags to the Brain Inbox, not to a Tidy tab that no longer exists', async () => {
  status.prefs.enabled = true
  await render()
  expect(container.textContent).toContain(
    'brain_flag to suggest a correction for Brain Agent to review during Defrag',
  )
  expect(container.textContent).not.toContain('on Tidy')
})

it('shows download progress and checking text without downloading again', async () => {
  status.prefs.enabled = true
  status.embedding = { ...status.embedding, phase: 'downloading', receivedBytes: 64.2 * 1024 ** 2 }
  await render()
  expect(container.querySelector('[role=status]')?.textContent).toContain(
    'Downloading EmbeddingGemma · 64.2 MB of 208.6 MB',
  )
  expect(container.querySelector('[style]')?.getAttribute('style')).toContain('width:')
  act(() =>
    useBrain.setState({
      status: { ...status, embedding: { ...status.embedding, phase: 'testing' } },
    }),
  )
  expect(container.textContent).toContain('Checking EmbeddingGemma…')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['brain:status'])
})

it('offers Remove model only when off and ready, and keeps knowledge copy', async () => {
  await render()
  expect(container.textContent).not.toContain('Remove model')
  status = {
    ...status,
    counts: { memories: 3, entities: 2 },
    embedding: { ...status.embedding, phase: 'ready' },
  }
  act(() => useBrain.setState({ status }))
  expect(container.textContent).toContain(
    'EmbeddingGemma (208.6 MB) and your 3 memories are kept on this computer.',
  )
  await click('Remove model')
  expect(invoke).toHaveBeenCalledWith('brain:removeModel')
  act(() => useBrain.setState({ status: { ...status, prefs: { ...status.prefs, enabled: true } } }))
  expect(container.textContent).not.toContain('Remove model')
  expect(container.textContent).toContain('EmbeddingGemma is ready. Search runs on this computer.')
  expect(container.textContent).toContain('3 memories about 2 things. Stored on this computer.')
})

it('retries a download error', async () => {
  status.embedding = { ...status.embedding, phase: 'error', error: 'Demo download failed' }
  await render()
  expect(container.textContent).toContain('Demo download failed')
  await click('Retry')
  expect(invoke).toHaveBeenCalledWith('brain:download')
})

it('recovers from a failed first status load', async () => {
  invoke.mockRejectedValueOnce(new Error('Demo unavailable'))
  await render()
  await click('Retry')
  expect(container.querySelector('[role=switch]')).not.toBeNull()
})

it('does not load or render Brain on unsupported platforms', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <BrainTab />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).toBe('')
  expect(invoke).not.toHaveBeenCalled()
})

it('requires explicit reset confirmation, keeps the model/settings copy, and calls reset once', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  await render()
  await click('Reset Brain knowledge')
  const request = usePromptStore.getState().requests[0]!
  expect(request.message).toContain('memories, entities, jobs and extraction records')
  expect(request.message).toContain('Keeps settings and the embedding model')
  expect(request.message).not.toContain('review')
  expect(invoke.mock.calls.some(([channel]) => channel === 'brain:reset')).toBe(false)
  await act(async () => usePromptStore.getState().dismiss(request, 'RESET'))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'brain:reset')).toHaveLength(1)
})

it('shows the reader setting only when Brain is on', async () => {
  await render()
  expect(container.textContent).not.toContain('Model that reads lanes')
  await click('Brain')
  expect(container.textContent).toContain('Model that reads lanes')
  expect(container.textContent).toContain("Each lane's own model")
  expect(container.textContent).toContain(
    'Brain reads every queued lane with this model. A lane already started keeps the model it started with.',
  )
})

it('chooses a catalogue model without cost and can return to each lane model', async () => {
  status.prefs.enabled = true
  await render()
  await click("Each lane's own model")
  const models = document.querySelector('[data-testid=model-list]')!
  expect(models, 'shared model menu').not.toBeNull()
  expect(models.textContent).not.toContain('$')
  const option = models.querySelector<HTMLButtonElement>('[data-testid=model-row]')!
  await act(async () => option.click())
  expect(invoke).toHaveBeenCalledWith('brain:setPrefs', { ...status.prefs, model: 'harbor/reader' })
  expect(container.textContent).toContain('Harbor Reader')
  await click("Use each lane's own model")
  expect(invoke).toHaveBeenLastCalledWith('brain:setPrefs', { ...status.prefs, model: null })
  expect(container.textContent).toContain("Each lane's own model")
})

it('keeps an unknown stored model visibly selected', async () => {
  status.prefs = { ...status.prefs, enabled: true, model: 'removed/reader' }
  await render()
  expect(container.textContent).toContain('removed/reader')
  expect(invoke.mock.calls.some(([channel]) => channel === 'brain:setPrefs')).toBe(false)
})

it('recovers a failed catalogue load when the reader picker is reopened', async () => {
  status.prefs.enabled = true
  const hydrate = vi
    .spyOn(useModelCatalogueStore.getState(), 'hydrate')
    .mockImplementation(async () => {})
  const models = useModelCatalogueStore.getState().models
  useModelCatalogueStore.setState({ status: 'error', models: [] })
  try {
    await render()
    await click("Each lane's own model")
    expect(document.body.textContent).toContain('Could not read the model list')
    const input = document.querySelector('[data-testid=model-search]')!
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    hydrate.mockImplementation(async () => {
      useModelCatalogueStore.setState({ status: 'ready', models })
    })
    await click("Each lane's own model")
    expect(document.body.textContent).toContain('Harbor Reader')
  } finally {
    hydrate.mockRestore()
  }
})

it('edits title rules, retains a failed draft for retry and leaves individual lane switches alone', async () => {
  status.prefs.enabled = true
  status.prefs.neverRead = { titles: ['1:1'], sessionIds: ['harbor-lane'] }
  await render()
  const field = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Lane title pattern"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field(),
      'Harbor prep',
    )
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
  invoke.mockRejectedValueOnce(new Error('Demo save failed'))
  await click('Add pattern')
  expect(field().value).toBe('Harbor prep')
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Demo save failed')
  await click('Add pattern')
  expect(field().value).toBe('')
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(status.prefs.neverRead).toEqual({
    titles: ['1:1', 'Harbor prep'],
    sessionIds: ['harbor-lane'],
  })
  const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Remove 1:1',
  )!
  await act(async () => remove.click())
  expect(status.prefs.neverRead).toEqual({ titles: ['Harbor prep'], sessionIds: ['harbor-lane'] })
})

it.each(['duplicate', 'limit'] as const)(
  'explains why a never-read pattern cannot be added: %s',
  async (reason) => {
    status.prefs.enabled = true
    status.prefs.neverRead = {
      titles:
        reason === 'duplicate' ? ['Harbor'] : Array.from({ length: 50 }, (_, i) => `Harbor ${i}`),
      sessionIds: [],
    }
    await render()
    const field = container.querySelector<HTMLInputElement>('[aria-label="Lane title pattern"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        field,
        'harbor',
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Add pattern',
    )!
    expect(add.disabled).toBe(true)
    expect(container.textContent).toContain(
      reason === 'duplicate' ? 'Already in the list' : 'Up to 50 patterns',
    )
    expect(field.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe(
      reason === 'duplicate' ? 'Already in the list' : 'Up to 50 patterns',
    )
  },
)
