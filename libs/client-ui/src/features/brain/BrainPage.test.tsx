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
import { useBrainNavigation } from './brainNavigation'
import { createMockBrain } from './mockBrain'
import { MOCK_SAID_AT } from './mockBrainData'
import { useBrain } from './useBrain'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let mock: ReturnType<typeof createMockBrain>
/** Channels that refuse their next call, once, as a failed first load does. */
let failOnce: Set<string>
const calls: [string, unknown[]][] = []
const CHANNELS: IpcInvokeChannel[] = [
  'brain:status',
  'brain:setPrefs',
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
  'brain:tidyUndo',
  'brain:extraction',
  'brain:ask',
  'brain:tell',
  'brain:setOwner',
  'brain:retry',
  'brain:cancel',
  'brain:path',
]
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  Element.prototype.scrollIntoView = vi.fn()
  mock = createMockBrain(() => MOCK_SAID_AT, { demo: true })
  failOnce = new Set()
  calls.length = 0
  await mock('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const handlers = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      async (...args: unknown[]) => {
        calls.push([channel, args])
        if (failOnce.delete(channel)) throw new Error(`${channel} is unavailable`)
        return mock(channel, args)
      },
    ]),
  ) as FakePhosphorHandlers
  fake = createFakePhosphor(handlers)
  restore = installFakePhosphor(fake)
  useBrain.setState({ status: null, saving: false, error: '' })
  useBrainNavigation.setState({ request: 0, target: null })
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
  await settle()
}
/** Let every pending load answer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
const region = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${name}"]`)
function button(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button, [role="button"]')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  )
}
async function click(text: string, scope: ParentNode = document): Promise<void> {
  const target = button(text, scope)
  expect(target, text).toBeDefined()
  await act(async () => target!.click())
  await settle()
}
const press = (key: string, target: Element, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
const card = () => region('Card')!
const cardTitle = () => card().querySelector('h2')?.textContent
const map = () => region('Map')!
const edge = (sentence: string) =>
  map().querySelector<SVGGElement>(`[data-edge][aria-label="${sentence}"]`)
const shownSentences = () =>
  [...map().querySelectorAll('[data-edge-sentence]')].map((node) => node.textContent)
const walkSteps = () =>
  [...region('Walk')!.querySelectorAll('li')].map((step) => step.textContent?.trim())
const called = (channel: string) => calls.filter(([name]) => name === channel).map(([, a]) => a)

it('is one screen: no tabs and no Lanes, with Defrag and how many things wait', async () => {
  await render()
  expect(container.querySelector('[role="tablist"]')).toBeNull()
  expect(region('Brain lanes')).toBeNull()
  expect(button('Lanes')).toBeUndefined()
  for (const name of ['Map', 'Card', 'Walk', 'Ask Brain', 'What changed'])
    expect(region(name), name).not.toBeNull()
  const status = useBrain.getState().status!
  const total = Object.values(status.agent.waiting).reduce((sum, n) => sum + n, 0)
  expect(container.querySelector('.page-shell-header')?.textContent).toContain(`${total} waiting`)
  expect(button('Defrag')?.dataset.tooltip).toContain('1 unlinked pair')
})

it('centres the map on you and opens your card', async () => {
  await render()
  const svg = map().querySelector('svg')!
  expect(svg.getAttribute('aria-label')).toBe('Map of Mara Voss and its neighbours')
  expect(map().querySelector('[aria-label^="Mara Voss,"]')?.getAttribute('aria-label')).toContain(
    '(centre)',
  )
  expect(cardTitle()).toBe('Mara Voss')
  expect(card().textContent).toContain('This is you')
  expect(called('brain:neighbourhood')[0]).toEqual(['mara', 1])
})

it('says an edge’s sentence on hover, and an ended one is dashed with its end date', async () => {
  await render()
  const handover = edge('Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)')
  expect(handover).not.toBeNull()
  expect(shownSentences()).not.toContain(
    'Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)',
  )
  await act(async () => handover!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  expect(shownSentences()).toContain(
    'Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)',
  )
  await click('Tom Lee reports to Mara Voss', card())
  const ended = edge('Tom Lee worked on Kestrel (until 2026-08-15)')!
  expect(ended.dataset.ended).toBe('true')
  expect(ended.querySelector('line')?.getAttribute('stroke-dasharray')).toBeTruthy()
  expect(ended.textContent).toContain('until 2026-08-15')
})

it('walks along relationships from the card, sentence by sentence, and steps back', async () => {
  await render()
  expect(walkSteps()).toEqual(['Mara Voss'])
  await click('Tom Lee reports to Mara Voss', card())
  expect(cardTitle()).toBe('Tom Lee')
  await click('Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)', card())
  expect(cardTitle()).toBe('Rina Okafor')
  expect(walkSteps()).toEqual([
    'Mara Voss',
    'Tom Lee reports to Mara Voss',
    'Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)',
  ])
  expect(map().querySelector('svg')!.getAttribute('aria-label')).toBe(
    'Map of Rina Okafor and its neighbours',
  )
  await click('Back', region('Walk')!)
  expect(cardTitle()).toBe('Tom Lee')
  await press('[', map())
  await settle()
  expect(cardTitle()).toBe('Mara Voss')
  await press(']', map())
  await settle()
  expect(cardTitle()).toBe('Tom Lee')
})

it('shows what is known now, before and named together, and memories in plain words', async () => {
  await render()
  await click('Tom Lee reports to Mara Voss', card())
  const now = region('Now')!.textContent
  expect(now).toContain('Tom Lee leads Ledger team (since 2026-09-01)')
  expect(region('Before')!.textContent).toContain('Tom Lee worked on Kestrel (until 2026-08-15)')
  expect(region('Together')!.textContent).toContain('+2 appear together, not explained yet')
  expect(region('Together')!.textContent).toContain('Northwind')
  const memories = region('Memories')!.textContent
  expect(memories).toContain('Tom Lee took over Ledger billing from Rina Okafor in September.')
  expect(memories).toContain('decision · still true · you said it · told · 2 lanes · important')
  expect(memories).toContain('an agent said it')
  await click('This is me', card())
  expect(called('brain:setOwner')).toEqual([['tom']])
})

it('asks Brain on Enter, lights the answer’s trail and lists its memories', async () => {
  await render()
  const input = region('Ask Brain')!.querySelector('textarea, input') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    setter.call(input, 'What is Mara busy with?')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await press('Enter', input)
  await settle()
  expect(called('brain:ask')).toEqual([['What is Mara busy with?']])
  expect(called('brain:tell')).toEqual([])
  const answer = region('Answer')!
  expect(answer.textContent).toContain('Mara Voss decided Ledger invoices close on the fifth')
  expect(answer.textContent).toContain('Mara Voss set the invoice close date for Ledger')
  expect(map().querySelectorAll('[data-edge][data-lit="true"]').length).toBeGreaterThan(0)
  expect(shownSentences()).toContain('Mara Voss set the invoice close date for Ledger')
})

it('tells Brain Agent with ⌘Enter, never asking, and offers its lane', async () => {
  await render()
  const input = region('Ask Brain')!.querySelector('textarea, input') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    setter.call(input, 'Kevin left the team')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await press('Enter', input, { metaKey: true })
  await settle()
  expect(called('brain:tell')).toEqual([['Kevin left the team']])
  expect(called('brain:ask')).toEqual([])
  expect(button('Open Brain lane')).toBeDefined()
})

it('lists a saved read in What changed with Undo, and opens how it was read', async () => {
  await render()
  const changes = region('What changed')!
  expect(changes.textContent).toContain('Read Ledger handover: 2 memories')
  expect(changes.textContent).toContain('Automatic')
  await click('How Ledger handover was read', changes)
  const dialog = region('How Ledger handover was read')!
  expect(dialog.getAttribute('role')).toBe('dialog')
  expect(dialog.textContent).toContain('Read the conversation · part 1')
  expect(dialog.textContent).not.toContain('demo/harbor-model')
  await press('Escape', dialog)
  await settle()
  const undo = [...changes.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Undo',
  )!
  await act(async () => undo.click())
  await settle()
  expect(called('brain:tidyUndo')).toHaveLength(1)
})

it('recovers a failed first load of the map with Retry', async () => {
  failOnce.add('brain:neighbourhood')
  await render()
  expect(map().textContent).toContain('brain:neighbourhood is unavailable')
  await click('Retry', map())
  expect(map().querySelector('svg')).not.toBeNull()
})

it('recovers a failed first load of Brain with Retry', async () => {
  failOnce.add('brain:status')
  await render()
  expect(container.textContent).toContain('brain:status is unavailable')
  await click('Retry')
  expect(region('Map')).not.toBeNull()
})

it('shows reads and failed reads in the status bar with Retry and Dismiss', async () => {
  await render()
  const bar = region('Brain status')!
  expect(bar.textContent).toContain('Ledger extraction to retry')
  expect(bar.textContent).toContain('1 lane queued')
  await click('Retry', bar)
  expect(called('brain:retry')).toEqual([['harbor-demo-failed']])
})

it('opens Brain search with / but leaves ⌘K to the command palette', async () => {
  await render()
  await press('k', map(), { metaKey: true })
  expect(region('Search Brain')).toBeNull()
  await press('/', map())
  await settle()
  const search = region('Search Brain')!
  expect(search.querySelector('[role="combobox"]')).toBe(document.activeElement)
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
})

it('never shows a model name, cost or tokens', async () => {
  await render()
  const status = (await mock('brain:status', [])) as BrainStatus
  expect(container.textContent).not.toMatch(/tokens|\$\d|demo\/harbor-model/)
  expect(status.jobs.some((job) => job.model === 'demo/harbor-model')).toBe(true)
})
