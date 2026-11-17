// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcInvokeMap } from '@shared/ipc'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { createMockBrain } from '../mockBrain'
import { useBrain } from '../useBrain'
import { BrainPage } from '../BrainPage'
import { openTidy, useTidyNavigation } from './tidyNavigation'

let root: Root,
  container: HTMLDivElement,
  fake: ReturnType<typeof createFakePhosphor>,
  restore: () => void
let mock: ReturnType<typeof createMockBrain>
async function call<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeMap[K]['args']
): Promise<IpcInvokeMap[K]['result']> {
  return (await mock(channel, args)) as IpcInvokeMap[K]['result']
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  mock = createMockBrain(() => 10000)
  await call('brain:setPrefs', { enabled: true, review: true, recall: true, model: null })
  fake = createFakePhosphor({
    'brain:status': () => call('brain:status'),
    'brain:history': (...args) => call('brain:history', ...args),
    'brain:entities': (...args) => call('brain:entities', ...args),
    'brain:recent': (...args) => call('brain:recent', ...args),
    'brain:overview': () => call('brain:overview'),
    'brain:entity': (...args) => call('brain:entity', ...args),
    'brain:neighbourhood': (...args) => call('brain:neighbourhood', ...args),
    'brain:entityMemories': (...args) => call('brain:entityMemories', ...args),
    'brain:tidy': (...args) => call('brain:tidy', ...args),
    'brain:tidySuggestion': (...args) => call('brain:tidySuggestion', ...args),
    'brain:tidyChanges': (...args) => call('brain:tidyChanges', ...args),
    'brain:proposal': (...args) => call('brain:proposal', ...args),
  })
  restore = installFakePhosphor(fake)
  useBrain.setState({ status: null, saving: false, error: '' })
  useTidyNavigation.setState({ request: 0, recent: false, tab: 'knowledge' })
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
async function render() {
  await act(async () => root.render(<BrainPage />))
}
async function tab(id: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`#brain-tab-${id}`)!.click())
}
it('shows the live Tidy count, preserves its selection/control across tabs and visits Knowledge', async () => {
  await render()
  expect(container.querySelector('#brain-tab-tidy')?.textContent).toBe('Tidy 12')
  await tab('tidy')
  const panel = container.querySelector('#brain-panel-tidy')!
  await act(async () =>
    [...panel.querySelectorAll('button')]
      .find((b) => b.textContent === 'Swap surviving record')!
      .click(),
  )
  await tab('lanes')
  await tab('knowledge')
  await tab('tidy')
  expect(
    [...panel.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Merge into'))
      ?.textContent,
  ).toBe('Merge into Rina')
  await act(async () =>
    [...panel.querySelectorAll('button')]
      .find((b) => b.textContent === 'View in Knowledge')!
      .click(),
  )
  expect(container.querySelector('#brain-tab-knowledge')?.getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(container.querySelector('[aria-label="Entity detail"] h2')?.textContent).toBe(
    'Rina Okafor',
  )
})
it('opens a notice on Tidy and an automatic-fold notice on Recent changes', async () => {
  await call('brain:tidy', null, null, 20)
  await call('brain:tidyApply', 'tidy-0', { kind: 'merge', survivorId: 'tidy-0-0' }, 0)
  await render()
  await act(async () => openTidy(true))
  expect(container.querySelector('#brain-tab-tidy')?.getAttribute('aria-selected')).toBe('true')
  expect(
    container.querySelector('[aria-label="Recent changes"] [aria-current="true"]'),
  ).not.toBeNull()
  expect(container.querySelector('[aria-label="Tidy detail"]')?.textContent).toContain(
    'Combined names, links and memories.',
  )
})
it('removes Tidy when disabled and never offers it on a platform without local Brain', async () => {
  await render()
  await tab('tidy')
  await act(async () =>
    useBrain.setState((s) => ({
      status: { ...s.status!, prefs: { ...s.status!.prefs, enabled: false } },
    })),
  )
  expect(container.querySelector('#brain-tab-tidy')).toBeNull()
  expect(container.querySelector('#brain-tab-knowledge')?.getAttribute('aria-selected')).toBe(
    'true',
  )
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <BrainPage />
      </PlatformProvider>,
    ),
  )
  expect(container.querySelector('[role="tab"]')).toBeNull()
})
