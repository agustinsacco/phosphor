// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { DEFAULT_APP_PREFS } from '@shared/models/prefs'
import type { MachineModelList } from '@shared/host-protocol-machine'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { RemoteModelPicker } from './RemoteModelPicker'
import { useRemoteModel } from './useRemoteModel'

let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let degraded = false
let attempts: number
let readModels: (() => Promise<MachineModelList>) | undefined
function Picker(): React.JSX.Element {
  const selection = useRemoteModel(MOCK_HOST_ID)
  return <RemoteModelPicker selection={selection} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  attempts = 0
  degraded = false
  readModels = undefined
  fake = createFakePhosphor({
    'app:getPrefs': () => DEFAULT_APP_PREFS,
    'pi:agentSettings': () => ({}),
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: 'opaque' }),
    'hosts:models': () => {
      attempts++
      if (readModels) return readModels()
      if (degraded) return { source: 'config' as const, models: [] }
      if (attempts === 1) throw new Error('temporary failure')
      return { models: [{ id: 'model', name: 'Recovered model', provider: 'p', reasoning: false }] }
    },
    'hosts:providers': () => [{ id: 'p', name: 'Provider', status: 'ready' }],
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
})
it('lets the user retry a failed initial catalogue read without leaving the composer', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <Picker />
      </PlatformProvider>,
    ),
  )
  const retry = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Retry models'),
  )
  expect(retry).toBeDefined()
  await act(async () => retry!.click())
  expect(el.textContent).toContain('Recovered model')
  expect(attempts).toBe(2)
})

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'keeps the Host popover visible as it loads and retries ($formFactor)',
  async (platform) => {
    let fail!: (error: Error) => void
    readModels = () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <Picker />
        </PlatformProvider>,
      ),
    )
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="remote-model-picker"]')!.click())
    const list = document.querySelector('[data-testid="model-list"]')!
    expect(list.textContent).toContain('Loading models…')
    expect(list.closest('[data-popup-menu]')?.parentElement).not.toBe(document.body)

    await act(async () => fail(new Error('unavailable')))
    expect(list.textContent).toContain('Could not read models.')
    const retry = [...list.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    expect(retry).toBeDefined()
    let finish!: (value: MachineModelList) => void
    readModels = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    act(() => retry!.click())
    expect(list.textContent).toContain('Loading models…')
    await act(async () =>
      finish({
        models: [{ id: 'model', name: 'Recovered model', provider: 'p', reasoning: false }],
      }),
    )
    expect(list.textContent).toContain('Recovered model')
    expect(list.textContent).not.toContain('Loading models…')
    expect(document.activeElement?.getAttribute('data-testid')).toBe('model-search')
  },
)

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'retries an empty config fallback in the open Host menu ($formFactor)',
  async (platform) => {
    degraded = true
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <Picker />
        </PlatformProvider>,
      ),
    )
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="remote-model-picker"]')!.click())
    const list = document.querySelector('[data-testid="model-list"]')!
    expect(list.textContent).toContain('Could not read models.')
    const retry = [...list.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    readModels = async () => ({ models: [] })
    await act(async () => retry.click())
    expect(attempts).toBe(2)
    expect(list.textContent).toContain('No signed-in model')
    expect(list.textContent).not.toContain('Could not read models.')
    expect(list.textContent).not.toContain('Retry')
  },
)

it('retries a transient error automatically while the picker is mounted', async () => {
  vi.useFakeTimers()
  try {
    await act(async () => root.render(<Picker />))
    expect(el.textContent).toContain('Retry models')
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(el.textContent).toContain('Recovered model')
    expect(attempts).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

it('backs off repeated config-only replies instead of polling every five seconds', async () => {
  degraded = true
  vi.useFakeTimers()
  try {
    await act(async () => root.render(<Picker />))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(attempts).toBe(2)
    await act(async () => vi.advanceTimersByTimeAsync(9999))
    expect(attempts).toBe(2)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(attempts).toBe(3)
  } finally {
    vi.useRealTimers()
  }
})
