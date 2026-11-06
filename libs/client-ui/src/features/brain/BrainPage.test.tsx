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
it.each(['all', 'remote-host'])(
  'binds initial %s selection to the explicit local-only boundary',
  async (filter) => {
    useRemoteLanesStore.setState({ filter })
    await act(async () =>
      root.render(
        <PlatformProvider value={DESKTOP_PLATFORM}>
          <BrainPage />
        </PlatformProvider>,
      ),
    )
    expect(container.textContent).toContain('Brain · This Mac')
    if (filter === 'all') {
      expect(invoke).toHaveBeenCalledWith('brain:status')
      expect(
        invoke.mock.calls.every(
          ([channel]) => typeof channel === 'string' && channel.startsWith('brain:'),
        ),
      ).toBe(true)
    } else {
      expect(container.textContent).toContain('unavailable')
      expect(invoke).not.toHaveBeenCalled()
    }
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
  const enabled = brainFixture()
  enabled.snapshot.prefs.enabled = true
  invoke.mockResolvedValueOnce(enabled)
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
it('requires saved enablement before a model download, even after terms consent', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:getPrefs') return { recentWorkspaces: [] }
    const status = brainFixture()
    status.snapshot.prefs.enabled = false
    return status
  })
  await act(async () => root.render(<BrainPage />))
  await click('Settings')
  await act(async () =>
    (
      container.querySelector('[aria-label="Accept embedding model terms"]') as HTMLInputElement
    ).click(),
  )
  const download = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Download local embedding model',
  )!
  expect(download.disabled).toBe(true)
  expect(invoke.mock.calls.some(([channel]) => channel === 'brain:download')).toBe(false)
})
it('lets a person search an explicit evidence branch without widening the empty default', async () => {
  await act(async () => root.render(<BrainPage />))
  const branch = container.querySelector(
    '[aria-label="Evidence branch"]',
  ) as HTMLInputElement | null
  expect(branch).not.toBeNull()
  const query = container.querySelector('form input') as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(query, 'Synthetic')
    query.dispatchEvent(new Event('input', { bubbles: true }))
    set.call(branch, 'feature/synthetic')
    branch!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(invoke).toHaveBeenCalledWith(
    'brain:search',
    expect.objectContaining({ query: 'Synthetic', branch: 'feature/synthetic' }),
  )
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
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!
        .disabled,
    ).toBe(false)
    invoke.mockResolvedValue({
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        policyEpoch: 3,
        prefs: {
          ...fixture.snapshot.prefs,
          processor: { provider: 'different-provider', id: 'different-model' },
        },
      },
    })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!
        .disabled,
    ).toBe(true)
    expect(invoke.mock.calls.some(([c]) => c === 'brain:process')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('does not poll while hidden and resumes a failed initial load on becoming visible', async () => {
  vi.useFakeTimers()
  try {
    invoke.mockRejectedValueOnce(new Error('first load offline'))
    await act(async () => root.render(<BrainPage />))
    invoke.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(invoke).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.textContent).toContain('Explore')
    expect(container.textContent).not.toContain('first load offline')
  } finally {
    vi.useRealTimers()
  }
})

it('requires explicit confirmation before decreasing retention', async () => {
  await act(async () => root.render(<BrainPage />))
  await click('Settings')
  const retention = container.querySelector('input[type="number"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(retention, '5')
    retention.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save Brain settings')!
      .disabled,
  ).toBe(true)
  expect(container.textContent).toContain('retained-since-capture')
})

it('recovers the enrollment workspace list after its first load fails', async () => {
  const normal = invoke.getMockImplementation()!
  let attempts = 0
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:getPrefs' && attempts++ === 0) throw new Error('workspaces offline')
    return normal(channel)
  })
  await act(async () => root.render(<BrainPage />))
  await click('Settings')
  expect(container.textContent).toContain('workspaces offline')
  await click('Retry workspaces')
  expect(container.textContent).not.toContain('workspaces offline')
})

it('processes only after explicit per-run consent and passes the exact enrolled workspace', async () => {
  const fixture = brainFixture()
  fixture.snapshot.prefs.enabled = true
  fixture.snapshot.prefs.processor = { provider: 'exact-provider', id: 'exact-model' }
  invoke.mockResolvedValue(fixture)
  await act(async () => root.render(<BrainPage />))
  await click('Activity')
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!
      .disabled,
  ).toBe(true)
  await act(async () =>
    (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  )
  await click('Process workspace')
  expect(invoke).toHaveBeenCalledWith('brain:process', '/synthetic', {
    policyEpoch: 2,
    model: { provider: 'exact-provider', id: 'exact-model' },
  })
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Process workspace')!
      .disabled,
  ).toBe(true)
})

it('requires explicit forgetting consent and warns that delivered copies survive', async () => {
  await act(async () => root.render(<BrainPage />))
  await click('Synthetic claim')
  await click('Forget cited evidence…')
  expect(container.textContent).toContain('Already delivered copies')
  const forget = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Confirm forget evidence',
  )!
  expect(forget.disabled).toBe(true)
  const confirmation = container.querySelector(
    '[aria-label="Confirm forgetting evidence"] input',
  ) as HTMLInputElement
  await act(async () => confirmation.click())
  await click('Confirm forget evidence')
  expect(invoke).toHaveBeenCalledWith('brain:forget', ['evidence'])
})

it('submits a human correction only with reason, confirmation and the reviewed revision', async () => {
  await act(async () => root.render(<BrainPage />))
  await click('Synthetic claim')
  await click('Correct claim…')
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm correction')!
      .disabled,
  ).toBe(true)
  const form = container.querySelector('[aria-label="Claim inspector"] form')!
  const reason = form.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      reason,
      'Human correction reason',
    )
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    ;(form.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
  })
  await click('Confirm correction')
  expect(invoke).toHaveBeenCalledWith(
    'brain:correct',
    'claim',
    expect.objectContaining({ reason: 'Human correction reason', literal: 'test' }),
    { graphRevision: 3, policyEpoch: 2 },
  )
})

it('keeps a refused review visible across successful background status polls', async () => {
  vi.useFakeTimers()
  try {
    const normal = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'brain:review') throw new Error('Stale review: refresh and review again')
      return normal(channel)
    })
    await act(async () => root.render(<BrainPage />))
    await click('Activity')
    await click('Reject')
    expect(container.textContent).toContain('Stale review: refresh and review again')
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.textContent).toContain('Stale review: refresh and review again')
  } finally {
    vi.useRealTimers()
  }
})
