// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainStatus } from '@shared/brain'
import type { IpcInvokeChannel } from '@shared/ipc'
import {
  createFakePhosphor,
  installFakePhosphor,
  type FakePhosphorHandlers,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { PromptHost } from '@/components/PromptHost'
import { BrainPage } from './BrainPage'
import { openBrain, openTidy, useBrainNavigation } from './brainNavigation'
import { createMockBrain } from './mockBrain'
import { mockBrainJob, mockBrainProposal } from './mockBrainData'
import { useBrain } from './useBrain'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let mock: ReturnType<typeof createMockBrain>
let defragError = ''
let defragPending: Promise<BrainStatus> | null
let patchStatus: ((status: BrainStatus) => BrainStatus) | null
const CHANNELS: IpcInvokeChannel[] = [
  'brain:status',
  'brain:describe',
  'brain:setPrefs',
  'brain:history',
  'brain:entities',
  'brain:recent',
  'brain:overview',
  'brain:entity',
  'brain:neighbourhood',
  'brain:entityMemories',
  'brain:connections',
  'brain:memory',
  'brain:find',
  'brain:defrag',
  'brain:defragStop',
  'brain:undoRun',
  'brain:tidyChanges',
  'brain:proposal',
  'brain:extraction',
]
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  mock = createMockBrain(() => 10000)
  patchStatus = null
  defragError = ''
  defragPending = null
  await mock('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const handlers = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      async (...args: unknown[]) => {
        if (channel === 'brain:defrag' && defragError) throw new Error(defragError)
        if (channel === 'brain:defrag' && defragPending) return defragPending
        const result = await mock(channel, args)
        return channel === 'brain:status' && patchStatus
          ? patchStatus(result as BrainStatus)
          : result
      },
    ]),
  ) as FakePhosphorHandlers
  fake = createFakePhosphor(handlers)
  restore = installFakePhosphor(fake)
  useBrain.setState({ status: null, saving: false, error: '' })
  useBrainNavigation.setState({ request: 0, target: null, tab: null })
  useSettingsUiStore.setState({ open: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <>
        <BrainPage />
        <PromptHost />
      </>,
    ),
  )
}
const tab = (id: string) => container.querySelector<HTMLButtonElement>(`#brain-tab-${id}`)!
const selectedTab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.id
const section = (name: string): HTMLElement => container.querySelector(`[aria-label="${name}"]`)!
function button(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  )
}
async function click(text: string, scope: ParentNode = container): Promise<void> {
  const target = button(text, scope)
  expect(target, text).toBeDefined()
  await act(async () => target!.click())
}
const press = (key: string, target: Element, init: KeyboardEventInit = {}) =>
  act(async () =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })),
  )
const search = () => container.querySelector<HTMLInputElement>('[role="combobox"]')
const goToAnyone = () =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Go to anyone or anything'),
  )!

it('has Knowledge and Lanes only, and offers Defrag with the waiting breakdown', async () => {
  await render()
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(tab('inbox')).toBeNull()
  const status = useBrain.getState().status!
  const total = Object.values(status.agent.waiting).reduce((sum, n) => sum + n, 0)
  expect(container.textContent).toContain(`${total} waiting`)
  expect(button('Defrag')?.disabled).toBe(false)
  expect(button('Defrag')?.dataset.tooltip).toContain(`${total} waiting: 1 read`)
  await click('Defrag')
  expect(container.textContent).toContain('Defrag starts after the reads already queued')
})

it.each(['off', 'empty', 'queued', 'running'])(
  'explains why Defrag is disabled: %s',
  async (state) => {
    patchStatus = (status) => {
      if (state === 'off') status.prefs.enabled = false
      if (state === 'empty')
        status.agent.waiting = { reads: 0, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
      if (state === 'queued' || state === 'running')
        status.agent.run = {
          id: 'run',
          state,
          total: 0,
          decided: 0,
          erased: 0,
          undoable: 0,
          queuedAt: 0,
          startedAt: null,
          finishedAt: null,
          sessionPath: null,
          error: null,
          rulesChanged: false,
        }
      return status
    }
    await render()
    expect(button('Defrag')?.disabled).toBe(true)
    expect(button('Defrag')?.dataset.tooltip).toMatch(
      /Turn Brain on|Nothing is waiting|already queued/,
    )
  },
)

it('shows a Defrag refusal as a recoverable action error', async () => {
  await render()
  defragError = 'Defrag unavailable'
  await click('Defrag')
  expect(useBrain.getState().error).toBe('Defrag unavailable')
})

it('opens on Knowledge with nothing to decide, and on Lanes before anything is known', async () => {
  patchStatus = (status) => ({ ...status, jobs: [], tidy: { ...status.tidy, open: 0 } })
  await render()
  expect(selectedTab()).toBe('brain-tab-knowledge')
  act(() => root.unmount())
  root = createRoot(container)
  patchStatus = (status) => ({
    ...status,
    jobs: [mockBrainJob({ state: 'queued' })],
    tidy: { ...status.tidy, open: 0 },
    counts: { memories: 0, entities: 0 },
  })
  useBrain.setState({ status: null })
  await render()
  expect(selectedTab()).toBe('brain-tab-lanes')
})

it('focuses Knowledge search with / from anywhere on the page, but not from a field', async () => {
  await render()
  await press('/', section('Index'))
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(document.activeElement).toBe(search())
  await press('/', search()!)
  expect(search()!.value).toBe('')
  await act(async () => tab('lanes').click())
  await press('k', section('Brain lanes'), { metaKey: true })
  expect(selectedTab()).toBe('brain-tab-lanes')
})

it('goes to Knowledge search from the header button', async () => {
  await render()
  await act(async () => goToAnyone().click())
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(document.activeElement).toBe(search())
})

it('opens Brain settings and refuses Brain on a platform without it', async () => {
  await render()
  await click('Settings')
  expect(useSettingsUiStore.getState().open).toBe(true)
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <BrainPage />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).toContain('Brain is available on Desktop')
  expect(container.querySelector('[role="tab"]')).toBeNull()
})

it('shows a thin status line only while Brain reads or checks, with a way to Lanes', async () => {
  patchStatus = (status) => ({
    ...status,
    jobs: [
      mockBrainJob({
        id: 'reading',
        title: 'Northwind contract',
        state: 'running',
        progress: { stage: 'reconcile', done: 1, total: 1 },
      }),
      mockBrainJob({ id: 'next', state: 'queued' }),
    ],
  })
  await render()
  const strip = container.querySelector('[role="status"]')!
  expect(strip.textContent).toContain(
    'Reading Northwind contract · Compare with what Brain knows · 1 queued',
  )
  await click('Lanes', strip)
  expect(selectedTab()).toBe('brain-tab-lanes')
})

it('names the review Brain refreshes in the status line, only while the refresh runs', async () => {
  const refreshing = mockBrainJob({ title: 'Kestrel rollout', state: 'refreshing' })
  patchStatus = (status) => ({ ...status, jobs: [{ ...refreshing, runStartedAt: null }] })
  await render()
  expect(container.textContent).not.toContain('Refreshing the review of')
  patchStatus = (status) => ({ ...status, jobs: [{ ...refreshing, runStartedAt: 10000 }] })
  await act(async () => useBrain.getState().refresh())
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Refreshing the review of Kestrel rollout',
  )
})

it('routes notices to Lanes and automatic changes to Recent changes', async () => {
  await mock('brain:merge', ['tom', 'rina', 0])
  await render()
  await act(async () => openTidy(true))
  expect(selectedTab()).toBe('brain-tab-lanes')
  expect(section('Recent changes').querySelector('[aria-current="true"]')).not.toBeNull()
  expect(section('Change detail').textContent).toContain('Combined names, links and memories.')
  await act(async () => openTidy())
  expect(selectedTab()).toBe('brain-tab-lanes')
})

it('selects Recent changes on a second Open recent changes', async () => {
  await mock('brain:merge', ['tom', 'rina', 0])
  await render()
  await act(async () => openTidy(true))
  const read = section('Brain lanes').querySelector<HTMLButtonElement>(
    'section:not([aria-label="Recent changes"]) button',
  )!
  await act(async () => read.click())
  expect(section('Recent changes').querySelector('[aria-current="true"]')).toBeNull()
  await act(async () => openTidy(true))
  expect(section('Recent changes').querySelector('[aria-current="true"]')).not.toBeNull()
  expect(section('Change detail').textContent).toContain('Combined names, links and memories.')
})

it('focuses the search again on a second click of the header button', async () => {
  await render()
  await act(async () => goToAnyone().click())
  expect(document.activeElement).toBe(search())
  search()!.blur()
  await act(async () => goToAnyone().click())
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(document.activeElement).toBe(search())
})

it('never replays a consumed request on a page mounted later', async () => {
  await render()
  await act(async () => openBrain({ tab: 'lanes' }))
  expect(selectedTab()).toBe('brain-tab-lanes')
  act(() => root.unmount())
  root = createRoot(container)
  await render()
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(useBrainNavigation.getState().request).toBe(1)
})

it('keeps stale waiting memories visible after a Knowledge edit without starting a refresh', async () => {
  await render()
  const before = useBrain.getState().status!
  const job = before.jobs.find((read) => read.state === 'review')!
  await mock('brain:describe', ['ledger', 'The Harbor ledger.', before.revision])
  await act(async () => useBrain.getState().refresh())
  await act(async () => tab('lanes').click())
  expect(section('Waiting read').textContent).toContain(mockBrainProposal(job).memories[0]!.summary)
  expect(section('Waiting read').textContent).toContain('Waits for Defrag')
  expect(section('Waiting read').textContent).not.toContain('refreshing this review')
  const after = (await mock('brain:status', [])) as BrainStatus
  expect(after.jobs.find((read) => read.id === job.id)).toEqual(job)
})

it('disables Defrag during its request and enables retry after a refusal', async () => {
  await render()
  let refuse!: (reason: Error) => void
  defragPending = new Promise<BrainStatus>((_resolve, reject) => {
    refuse = reject
  })
  await click('Defrag')
  expect(button('Defrag')?.disabled).toBe(true)
  await click('Defrag')
  await act(async () => refuse(new Error('Defrag unavailable')))
  expect(useBrain.getState().error).toBe('Defrag unavailable')
  expect(button('Defrag')?.disabled).toBe(false)
  defragPending = null
  await click('Defrag')
  expect(container.textContent).toContain('Defrag starts after the reads already queued')
})
