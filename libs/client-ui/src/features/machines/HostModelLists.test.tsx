// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import type { Model } from '@shared/rpc'
import type { MachineModel } from '@shared/host-protocol-machine'
import { DEFAULT_APP_PREFS } from '@shared/models/prefs'
import { DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineCatalogueKey, useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { useModelPicksStore } from '@/stores/modelPicks'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { ModelPicker } from '@/features/chat/composer/ModelPicker'
import { RemoteModelPicker, useRemoteModel } from './RemoteModelPicker'

const facts = { contextWindow: 200_000, input: ['text'] }
const MODELS: MachineModel[] = [
  { id: 'ready-model', name: 'Ready model', provider: 'ready', reasoning: false, ...facts },
  { id: 'signed-out', name: 'Signed out model', provider: 'cloud', reasoning: false, ...facts },
  { id: 'unlisted', name: 'Key model', provider: 'api-key', reasoning: false, ...facts },
]
const LANE_MODELS: Model[] = MODELS.map((m) => ({
  ...m,
  api: m.provider,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}))
const SESSION = mockRemoteInfo.sessionId
let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  useModelPicksStore.setState({ starred: [], recent: [], groupMode: 'family', hydrated: true })
  fake = createFakePhosphor({
    'app:getPrefs': () => DEFAULT_APP_PREFS,
    'app:setModelPicks': () => undefined,
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({
    catalogues: {
      [machineCatalogueKey(MOCK_HOST_ID)]: {
        status: 'ready',
        error: null,
        models: MODELS,
        // pi lists only models it can run; the Host's sign-in check knows these providers.
        providers: [
          { id: 'ready', name: 'Ready Cloud', status: 'ready' },
          { id: 'cloud', name: 'Signed Out Cloud', status: 'not_ready' },
        ],
      },
    },
  })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
  useSessionsStore.setState({
    live: { [SESSION]: { ...mockRemoteInfo, phosphorId: SESSION } },
  })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(SESSION)
  useChatStore.getState().setModels(SESSION, LANE_MODELS)
  useChatStore.getState().setMeta(SESSION, {
    model: LANE_MODELS[0]!,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionId: SESSION,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  })
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
function StartPicker(): React.JSX.Element {
  return <RemoteModelPicker selection={useRemoteModel(MOCK_HOST_ID)} />
}
/** Open the picker behind `chip` and read every row: its text and whether it can be picked. */
async function rows(content: React.ReactNode, chip: string): Promise<string[]> {
  await act(async () =>
    root.render(<PlatformProvider value={DESKTOP_PLATFORM}>{content}</PlatformProvider>),
  )
  await act(async () => el.querySelector<HTMLButtonElement>(`[data-testid="${chip}"]`)!.click())
  const listed = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="model-row"]')]
  const read = listed.map(
    (row) =>
      `${row.textContent}|${row.disabled || row.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled'}`,
  )
  await act(async () => root.render(null))
  return read
}

it('lists the same Host models with the same disabled state before and inside a lane', async () => {
  const start = await rows(<StartPicker />, 'remote-model-picker')
  const lane = await rows(<ModelPicker sessionId={SESSION} />, 'model-chip')
  expect(lane).toEqual(start)
  expect(start).toHaveLength(3)
  const row = (name: string) => start.find((entry) => entry.startsWith(name))
  expect(row('Ready model')).toMatch(/\|enabled$/)
  expect(row('Key model')).toMatch(/\|enabled$/)
  expect(row('Signed out model')).toContain(`Sign in to Signed Out Cloud on ${MOCK_HOST_ID}`)
  expect(row('Signed out model')).toMatch(/\|disabled$/)
})
