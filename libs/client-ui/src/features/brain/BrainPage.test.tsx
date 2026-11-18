// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainStatus } from '@shared/brain'
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
import { mockBrainJob } from './mockBrainData'
import { useBrain } from './useBrain'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let mock: ReturnType<typeof createMockBrain>
let patchStatus: ((status: BrainStatus) => BrainStatus) | null
/** Every suggestion whose detail the Inbox loaded, in order: the last one is on screen. */
const detailed: string[] = []
const CHANNELS: IpcInvokeChannel[] = [
  'brain:status',
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
  'brain:tidy',
  'brain:tidySuggestion',
  'brain:tidyChanges',
  'brain:tidyApply',
  'brain:tidyCancel',
  'brain:proposal',
  'brain:review',
  'brain:extraction',
]
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  mock = createMockBrain(() => 10000)
  patchStatus = null
  detailed.length = 0
  await mock('brain:setPrefs', [{ enabled: true, review: true, recall: true, model: null }])
  const handlers = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      async (...args: unknown[]) => {
        if (channel === 'brain:tidySuggestion') detailed.push(args[0] as string)
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

it('opens on the Inbox with its count, and shows the Brain totals in the title', async () => {
  await render()
  expect(selectedTab()).toBe('brain-tab-inbox')
  const status = useBrain.getState().status!
  expect(tab('inbox').textContent).toBe(`Inbox ${1 + status.tidy.open}`)
  expect(container.textContent).toMatch(/\d+ memories · \d+ people and things/)
  expect(container.querySelector('#brain-tab-tidy')).toBeNull()
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
  await press('/', section('Decisions'))
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(document.activeElement).toBe(search())
  await press('/', search()!)
  expect(search()!.value).toBe('')
  await act(async () => tab('inbox').click())
  await press('k', section('Decisions'), { metaKey: true })
  expect(selectedTab()).toBe('brain-tab-inbox')
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

it('routes a notice to the Inbox, and an automatic change to Lanes › Recent changes', async () => {
  await mock('brain:tidy', [null, null, 20])
  await mock('brain:tidyApply', ['tidy-0', { kind: 'merge', survivorId: 'tidy-0-0' }, 0])
  await render()
  await act(async () => openTidy(true))
  expect(selectedTab()).toBe('brain-tab-lanes')
  expect(section('Recent changes').querySelector('[aria-current="true"]')).not.toBeNull()
  expect(section('Change detail').textContent).toContain('Combined names, links and memories.')
  await act(async () => openTidy())
  expect(selectedTab()).toBe('brain-tab-inbox')
  await act(async () => openBrain({ tab: 'inbox', item: 'suggestion:tidy-2' }))
  expect(section('Tidy suggestion')).not.toBeNull()
})

it('selects Recent changes on a second Open recent changes', async () => {
  await mock('brain:tidy', [null, null, 20])
  await mock('brain:tidyApply', ['tidy-0', { kind: 'merge', survivorId: 'tidy-0-0' }, 0])
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

it('routes a second notice to its own item', async () => {
  await render()
  await act(async () => openBrain({ tab: 'inbox', item: 'suggestion:tidy-2' }))
  expect(detailed.at(-1)).toBe('tidy-2')
  await act(async () => openBrain({ tab: 'inbox', item: 'suggestion:tidy-5' }))
  expect(detailed.at(-1)).toBe('tidy-5')
})

it('opens a profile from the Inbox and keeps the Inbox selection across tabs', async () => {
  await render()
  await press('j', section('Decisions'))
  const chosen = section('Decisions').querySelector('[aria-current="true"]')!.textContent
  await click('Open profile', section('What Brain knows'))
  expect(selectedTab()).toBe('brain-tab-knowledge')
  expect(section('Profile').querySelector('h2')).not.toBeNull()
  await act(async () => tab('inbox').click())
  expect(section('Decisions').querySelector('[aria-current="true"]')!.textContent).toBe(chosen)
})

it('approves a review, then finds its read in Lanes', async () => {
  await render()
  await press('a', section('Decisions'))
  expect(section('Decisions').textContent).not.toContain('Harbor identity review')
  await click('Lanes')
  expect(section('Read').textContent).toContain('Harbor identity review')
})

it('walks from a Knowledge memory to the read that produced it, and back', async () => {
  await render()
  await press('a', section('Decisions'))
  await act(async () => tab('knowledge').click())
  const learned = section('Recently learned').querySelector<HTMLButtonElement>('button')!
  await act(async () => learned.click())
  await click('See the read', section('Profile'))
  expect(selectedTab()).toBe('brain-tab-lanes')
  expect(section('Read detail').querySelector('h2')?.textContent).toBe('Harbor identity review')
  const memory = section('Read detail').querySelector<HTMLButtonElement>('details li button')!
  await act(async () => memory.click())
  expect(selectedTab()).toBe('brain-tab-knowledge')
})

it('reloads every tab after a reset', async () => {
  await render()
  const before = useBrain.getState().status!.generation
  await act(async () =>
    useBrain.setState({
      status: { ...useBrain.getState().status!, generation: `${before}-reset`, jobs: [] },
    }),
  )
  expect(section('Decisions')).not.toBeNull()
  expect(section('Decisions').textContent).not.toContain('Harbor identity review')
})
