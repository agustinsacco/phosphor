// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { BrainPage } from './BrainPage'
import { brainFixture } from './__fixtures__/brain'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  PlatformProvider,
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  WIDE_BROWSER_PLATFORM,
} from '@/platform/Platform'

let root: Root, container: HTMLDivElement
const invoke = vi.fn()
const click = async (text: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    configurable: true,
  })
  useRemoteLanesStore.setState({ filter: 'local' })
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'brain:status') return brainFixture()
    if (channel === 'app:getPrefs')
      return { recentWorkspaces: [{ path: '/synthetic', name: 'Synthetic' }] }
    if (channel === 'brain:graph')
      return {
        nodes: brainFixture().snapshot.entities,
        edges: brainFixture().snapshot.claims,
        truncated: false,
      }
    if (channel === 'brain:read')
      return {
        id: 'evidence',
        text: 'Original synthetic quote',
        label: 'Synthetic note',
        role: 'user',
        scope: '/synthetic',
        observedAt: 1,
        rootIds: ['root'],
      }
    return brainFixture()
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it('recovers after first status load fails using Retry', async () => {
  invoke.mockRejectedValueOnce(new Error('temporary failure'))
  await act(async () => root.render(<BrainPage />))
  expect(container.textContent).toContain('temporary failure')
  await click('Retry')
  expect(container.textContent).toContain('Explore')
})
it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'never invokes local Brain from browser capabilities',
  async (platform) => {
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <BrainPage />
        </PlatformProvider>,
      ),
    )
    expect(container.textContent).toContain('unavailable')
    expect(invoke).not.toHaveBeenCalled()
  },
)
it('drops local data on remote selection and reloads when local returns', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={DESKTOP_PLATFORM}>
        <BrainPage />
      </PlatformProvider>,
    ),
  )
  invoke.mockClear()
  await act(async () => useRemoteLanesStore.setState({ filter: 'remote-host' }))
  expect(container.textContent).toContain('unavailable')
  expect(container.textContent).not.toContain('Synthetic claim')
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
  expect(invoke).toHaveBeenCalledWith('brain:status')
})
it('requires separate explicit terms consent before downloading and does not process on mount', async () => {
  await act(async () => root.render(<BrainPage />))
  expect(invoke.mock.calls.some(([c]) => c === 'brain:process' || c === 'brain:download')).toBe(
    false,
  )
  await click('Settings')
  const download = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Download local embedding model',
  )!
  expect(download.disabled).toBe(true)
  await act(async () =>
    (
      container.querySelector('[aria-label="Accept embedding model terms"]') as HTMLInputElement
    ).click(),
  )
  await click('Download local embedding model')
  expect(invoke).toHaveBeenCalledWith('brain:download', true)
})
it('reviews original evidence before enabling revision-checked approval', async () => {
  await act(async () => root.render(<BrainPage />))
  await click('Activity')
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!.disabled,
  ).toBe(true)
  await click('Read original evidence')
  expect(container.textContent).toContain('Original synthetic quote')
  await click('Approve')
  expect(invoke).toHaveBeenCalledWith('brain:review', 'proposal', true, {
    graphRevision: 3,
    policyEpoch: 2,
  })
})
it('provides keyboard-operable entity list and pauses graph for reduced motion', async () => {
  await act(async () => root.render(<BrainPage />))
  expect(container.querySelector('.brain-graph')?.getAttribute('data-paused')).toBe('true')
  const entity = container.querySelector(
    'button[aria-label="Explore Synthetic project"]',
  ) as HTMLButtonElement
  entity.focus()
  expect(document.activeElement).toBe(entity)
  await act(async () => entity.click())
  expect(invoke).toHaveBeenCalledWith('brain:graph', 'entity')
})

it('binds a searched claim correction to the revision actually reviewed', async () => {
  const fixture = brainFixture()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'brain:search')
      return {
        graphRevision: 1,
        policyEpoch: 1,
        status: 'ok',
        results: [
          { claim: fixture.snapshot.claims[0], evidence: [], reasons: ['lexical'], score: 1 },
        ],
        entities: fixture.snapshot.entities,
        degradation: [],
        truncated: false,
      }
    return fixture
  })
  await act(async () => root.render(<BrainPage />))
  const search = container.querySelector('input[maxlength="2000"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'synthetic',
    )
    search.dispatchEvent(new Event('input', { bubbles: true }))
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await click('Synthetic claim')
  await click('Correct claim…')
  expect(container.textContent).toContain('Uses graph revision 1 and policy epoch 1')
})

it('requires processing consent again if the configured model or enrollment policy changes', async () => {
  vi.useFakeTimers()
  try {
    const fixture = brainFixture()
    fixture.snapshot.prefs.enabled = true
    fixture.snapshot.prefs.processor = { provider: 'explicit-provider', id: 'first-model' }
    invoke.mockResolvedValue(fixture)
    await act(async () => root.render(<BrainPage />))
    await click('Activity')
    const consent = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => consent.click())
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!.disabled).toBe(false)
    invoke.mockResolvedValue({ ...fixture, snapshot: { ...fixture.snapshot, policyEpoch: 3, prefs: { ...fixture.snapshot.prefs, processor: { provider: 'different-provider', id: 'different-model' } } } })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!.disabled).toBe(true)
    expect(invoke.mock.calls.some(([c]) => c === 'brain:process')).toBe(false)
  } finally { vi.useRealTimers() }
})

it('does not poll while hidden and resumes a failed initial load on becoming visible', async () => {
  vi.useFakeTimers()
  try {
    invoke.mockRejectedValueOnce(new Error('first load offline'))
    await act(async () => root.render(<BrainPage />))
    invoke.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(9000) })
    expect(invoke).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.textContent).toContain('Explore')
    expect(container.textContent).not.toContain('first load offline')
  } finally { vi.useRealTimers() }
})
