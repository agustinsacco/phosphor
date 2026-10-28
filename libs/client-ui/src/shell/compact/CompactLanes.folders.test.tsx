// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompactLanes } from './CompactLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { MACHINE } from '@/features/machines/__fixtures__/control'

const invoke = vi.fn().mockResolvedValue(undefined)
const SECOND = '0000000000000002'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  invoke.mockClear()
  useMachinesStore.setState({
    machines: [{ ...MACHINE, id: MOCK_HOST_ID }],
    loading: false,
    error: null,
  })
})
afterEach(() => vi.unstubAllGlobals())

function host(writable: boolean) {
  const view = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  view.repositories.push({ id: SECOND, name: 'Second repository', path: '/remote/b' })
  if (writable) view.capabilities.push('workspaces.write')
  return view
}

async function render(inbox = false) {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () =>
    root.render(
      <NavigationProvider
        value={{ location: { to: inbox ? 'inbox' : 'lanes' }, navigate: vi.fn() }}
      >
        <CompactLanes inbox={inbox} />
      </NavigationProvider>,
    ),
  )
  return {
    element,
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount())
      element.remove()
    },
  }
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text || b.textContent?.startsWith(text),
  )

it('offers the Host folder menu in the browser: add, remove and move through the Host', async () => {
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host(true) }, snapshotStatus: 'ready' })
  await using view = await render()
  const options = view.element.querySelector<HTMLButtonElement>(
    '[aria-label="Workspace options for Demo repository"]',
  )!
  act(() => options.click())
  expect(button('Add folder on')?.disabled).toBe(false)
  expect(button('Remove from')?.disabled).toBe(false)
  expect(button('Move up')?.disabled).toBe(true)
  await act(async () => button('Move down')!.click())
  expect(invoke).toHaveBeenLastCalledWith('hosts:orderRepositories', MOCK_HOST_ID, [
    SECOND,
    '0000000000000001',
  ])
  act(() => options.click())
  act(() => button('Remove from')!.click())
  await act(async () => button('Remove folder')!.click())
  expect(invoke).toHaveBeenLastCalledWith(
    'hosts:removeRepository',
    MOCK_HOST_ID,
    '0000000000000001',
  )
})

it('lists a folder with no lanes, so it can still be managed', async () => {
  const view = host(true)
  view.lanes = []
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: view }, snapshotStatus: 'ready' })
  await using rendered = await render()
  expect(rendered.element.textContent).toContain('Second repository')
  expect(
    rendered.element.querySelector('[aria-label="Workspace options for Second repository"]'),
  ).not.toBeNull()
})

it('keeps the folder menu out of the Inbox and the moves off without workspaces.write', async () => {
  const view = host(false)
  view.lanes = [{ ...view.lanes[0]!, attention: 2, read: 1 }]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: view }, snapshotStatus: 'ready' })
  {
    await using inbox = await render(true)
    expect(inbox.element.querySelector('[aria-label^="Workspace options"]')).toBeNull()
  }
  await using lanes = await render()
  act(() =>
    lanes.element
      .querySelector<HTMLButtonElement>('[aria-label="Workspace options for Demo repository"]')!
      .click(),
  )
  for (const text of ['Add folder on', 'Remove from', 'Move up', 'Move down'])
    expect(button(text)?.disabled, text).toBe(true)
})
