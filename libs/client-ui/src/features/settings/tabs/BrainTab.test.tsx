// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainStatus } from '@shared/brain'
import { mockBrainStatus } from '@/features/brain/mockBrainData'
import { useBrain } from '@/features/brain/useBrain'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { BrainTab } from './BrainTab'

let root: Root
let container: HTMLDivElement
let status: BrainStatus
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  status = mockBrainStatus()
  useBrain.setState({ status: null, error: '', saving: false })
  invoke.mockReset().mockImplementation(async (channel: string, prefs: unknown) => {
    if (channel === 'brain:setPrefs') status = { ...status, prefs: prefs as BrainStatus['prefs'] }
    return structuredClone(status)
  })
  vi.stubGlobal('phosphor', { invoke })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
const render = async (): Promise<void> => {
  await act(async () => root.render(<BrainTab />))
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
    ['brain:setPrefs', { enabled: true, recall: true, review: true }],
  ])
  expect(container.textContent).toContain('Recall in lanes')
  expect(container.textContent).toContain('Review before saving')
  expect(container.textContent).toContain('Open Brain')
  await click('Recall in lanes')
  expect(invoke).toHaveBeenLastCalledWith('brain:setPrefs', {
    enabled: true,
    recall: false,
    review: true,
  })
  await click('Review before saving')
  expect(invoke).toHaveBeenLastCalledWith('brain:setPrefs', {
    enabled: true,
    recall: false,
    review: false,
  })
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
  expect(invoke.mock.calls.some(([channel]) => channel === 'brain:reset')).toBe(false)
  await act(async () => usePromptStore.getState().dismiss(request, 'RESET'))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'brain:reset')).toHaveLength(1)
})
