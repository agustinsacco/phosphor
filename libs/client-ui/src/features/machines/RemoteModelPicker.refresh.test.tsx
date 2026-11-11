// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { RemoteModelPicker } from './RemoteModelPicker'
import { useRemoteModel } from './useRemoteModel'

/*
 * A Host's sign-ins and models change while Phosphor holds its catalogue: the
 * user signs in to Claude on it, or upgrades its pi to one that lists a new
 * model. Opening the new-lane picker is when that matters.
 */

let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let signedIn: boolean
let upgraded: boolean
let reads: number
const T0 = 1_000_000

function Picker(): React.JSX.Element {
  const selection = useRemoteModel(MOCK_HOST_ID)
  return <RemoteModelPicker selection={selection} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(Date, 'now').mockReturnValue(T0)
  signedIn = false
  upgraded = false
  reads = 0
  fake = createFakePhosphor({
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: 'opaque' }),
    'hosts:models': () => [
      { id: 'qwen', name: 'Local Qwen', provider: 'local-stark', reasoning: false },
      {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        provider: 'pi-claude-cli',
        reasoning: true,
      },
      ...(upgraded
        ? [
            {
              id: 'claude-fable-5-2',
              name: 'Claude Fable 5.2',
              provider: 'pi-claude-cli',
              reasoning: true,
            },
          ]
        : []),
    ],
    'hosts:providers': () => {
      reads++
      return [{ id: 'pi-claude-cli', name: 'Claude CLI', status: signedIn ? 'ready' : 'not_ready' }]
    },
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

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <Picker />
      </PlatformProvider>,
    ),
  )
}
async function toggleMenu(): Promise<void> {
  const chip = el.querySelector<HTMLButtonElement>('[data-testid="remote-model-picker"]')!
  await act(async () => chip.click())
}
const text = (): string => document.body.textContent ?? ''

it('re-reads an old catalogue when the picker opens, so a sign-in and a new model show', async () => {
  await render()
  await toggleMenu()
  expect(text()).toContain('Sign in to Claude CLI')
  await toggleMenu()

  signedIn = true
  upgraded = true
  vi.mocked(Date.now).mockReturnValue(T0 + 5 * 60_000)
  await toggleMenu()
  await vi.waitFor(() => expect(text()).toContain('Claude Fable 5.2'))
  expect(text()).not.toContain('Sign in to Claude CLI')
  expect(reads).toBe(2)
})
