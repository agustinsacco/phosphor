// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyPage } from '@shared/brain-tidy'
import type { IpcInvokeChannel } from '@shared/ipc'
import {
  createFakePhosphor,
  installFakePhosphor,
  type FakePhosphorHandlers,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { createMockBrain } from '../mockBrain'
import { useBrain } from '../useBrain'
import { useTidyPage } from '../tidy/useTidyPage'
import { BrainInbox } from './BrainInbox'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let call: ReturnType<typeof createMockBrain>
let selected: string | null
/** Rewrites each `brain:tidy` page, as a sweep that adds newer rows would. */
let patchPage: ((page: BrainTidyPage) => BrainTidyPage) | null
const calls: { channel: string; args: unknown[] }[] = []
const onEntity = vi.fn()
const CHANNELS: IpcInvokeChannel[] = [
  'brain:status',
  'brain:tidy',
  'brain:tidySuggestion',
  'brain:tidyApply',
  'brain:tidyDismiss',
  'brain:tidyRun',
  'brain:tidyCancel',
  'brain:proposal',
  'brain:review',
  'brain:entity',
  'brain:history',
]

function Harness(): React.JSX.Element {
  const tidy = useTidyPage(true)
  const [current, setCurrent] = useState<string | null>(null)
  selected = current
  return (
    <BrainInbox
      tidy={tidy}
      selected={current}
      onSelect={setCurrent}
      onEntity={onEntity}
      onVisit={() => {}}
    />
  )
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  call = createMockBrain(() => 10000)
  calls.length = 0
  patchPage = null
  onEntity.mockClear()
  const handlers = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      async (...args: unknown[]) => {
        calls.push({ channel, args })
        const result = await call(channel, args)
        if (channel === 'brain:tidy' && patchPage) return patchPage(result as BrainTidyPage)
        if (channel === 'brain:review' || channel.startsWith('brain:tidy'))
          useBrain.setState({ status: (await call('brain:status', [])) as BrainStatus })
        return result
      },
    ]),
  ) as FakePhosphorHandlers
  fake = createFakePhosphor(handlers)
  restore = installFakePhosphor(fake)
  useBrain.setState({
    status: (await call('brain:status', [])) as BrainStatus,
    error: '',
    saving: false,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
const render = () => act(async () => root.render(<Harness />))
const section = (name: string): HTMLElement => container.querySelector(`[aria-label="${name}"]`)!
const press = (key: string, target: Element = section('Decisions')) =>
  act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
function button(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  )
}
const reviewTitle = () => section('Review memories')?.querySelector('h2')?.textContent
const lastCall = (channel: string) => calls.findLast((c) => c.channel === channel)?.args
/** Open the second Same person or thing? pair, then reload with it beyond the loaded page. */
async function pushOpenSuggestionOffThePage(): Promise<string> {
  await render()
  await press('j')
  await press('j')
  const open = selected!
  expect(open).toBe('suggestion:tidy-4')
  // Still open and still counted, but older than every row the reload brought back.
  patchPage = (page) => ({ ...page, items: page.items.filter((item) => item.id !== 'tidy-4') })
  const status = useBrain.getState().status!
  await act(async () => useBrain.setState({ status: { ...status, revision: status.revision + 1 } }))
  return open
}

it('lists every decision by kind with counts and opens the oldest review first', async () => {
  await render()
  const queue = section('Decisions')
  const groups = [...queue.querySelectorAll('section')].map((group) => group.ariaLabel)
  expect(groups[0]).toBe('From lanes')
  expect(groups).toContain('Same person or thing?')
  expect(queue.textContent).toContain('From lanes · 1')
  expect(queue.textContent).toContain('Harbor identity review')
  expect(queue.textContent).not.toContain('Ledger extraction to retry')
  expect(selected).toBe('review:harbor-demo-review')
  expect(reviewTitle()).toBe('Harbor identity review')
})

it('moves with j and k, and ignores keys typed into a field', async () => {
  await render()
  await press('j')
  expect(selected).toMatch(/^suggestion:/)
  expect(section('Tidy suggestion')).not.toBeNull()
  await press('k')
  expect(selected).toBe('review:harbor-demo-review')
  const field = document.createElement('input')
  section('Decision').append(field)
  await press('j', field)
  expect(selected).toBe('review:harbor-demo-review')
})

it('approves with a, then opens the next decision and drops the review from the queue', async () => {
  await render()
  await press('a')
  expect(calls.find((c) => c.channel === 'brain:review')?.args[1]).not.toBeNull()
  expect(section('Decisions').textContent).not.toContain('Harbor identity review')
  expect(selected).toMatch(/^suggestion:/)
})

it('rejects a review with r, and r does nothing on a Tidy suggestion', async () => {
  await render()
  await press('j')
  await press('r')
  expect(calls.some((c) => c.channel.startsWith('brain:tidyApply'))).toBe(false)
  await press('k')
  await press('r')
  expect(calls.find((c) => c.channel === 'brain:review')?.args[1]).toBeNull()
})

it('keeps the open detail when a reload moves its row beyond the loaded page', async () => {
  const open = await pushOpenSuggestionOffThePage()
  expect(selected).toBe(open)
  expect(lastCall('brain:tidySuggestion')).toEqual(['tidy-4'])
  expect(section('Tidy suggestion')).not.toBeNull()
  expect(section('Decisions').querySelector('[aria-current="true"]')).not.toBeNull()
})

it('applies with a, after such a reload, the suggestion the owner sees', async () => {
  await pushOpenSuggestionOffThePage()
  await press('a')
  expect(lastCall('brain:tidyApply')?.[0]).toBe('tidy-4')
})

it('shows what Brain knows about the people and things in the open decision', async () => {
  await render()
  const context = section('What Brain knows')
  expect(context.querySelectorAll('article').length).toBeGreaterThan(0)
  const open = button('Open profile', context)!
  await act(async () => open.click())
  expect(onEntity).toHaveBeenCalledWith(expect.any(String), expect.any(String))
})

it('starts a model check from under the queue and says nothing is left when empty', async () => {
  await render()
  await act(async () => button('Check for repeats')!.click())
  expect(calls.some((c) => c.channel === 'brain:tidyRun')).toBe(true)
  useBrain.setState({ status: { ...useBrain.getState().status!, jobs: [] } })
  for (let left = 30; left && section('Decisions').querySelector('[data-inbox-row]'); left--)
    await act(async () => {
      const first = section('Decisions').querySelector<HTMLButtonElement>('[data-inbox-row]')!
      first.click()
      const dismiss = button('Not the same') ?? button('Keep')
      dismiss?.click()
    })
  expect(section('Decisions').textContent).toContain('Nothing to decide.')
})
