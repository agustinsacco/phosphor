// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineModelDefaults } from '@shared/host-protocol-machine'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
} from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { useRemoteModel } from './useRemoteModel'

// `first` is the signed-in fallback; `blocked` is listed but its provider is signed out.
const models = [
  { id: 'first', name: 'First', provider: 'p', reasoning: true },
  { id: 'last', name: 'Last', provider: 'p', reasoning: true },
  { id: 'host', name: 'Host default', provider: 'p', reasoning: true },
  { id: 'mac', name: 'Mac default', provider: 'p', reasoning: true },
  { id: 'blocked', name: 'Blocked', provider: 'off', reasoning: true },
]
const providers = [
  { id: 'p', name: 'Provider', status: 'ready' },
  { id: 'off', name: 'Offline', status: 'not_ready' },
]
const MAC_SETTINGS = { defaultProvider: 'p', defaultModel: 'mac', defaultThinkingLevel: 'minimal' }
const BROWSERS = [WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM]
const ALL = [DESKTOP_PLATFORM, ...BROWSERS]

let root: Root
let container: HTMLDivElement
let hostDefaults: MachineModelDefaults | undefined
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'hosts:skills') return { skills: [], probe: 'rpc', userRoot: 'opaque' }
  if (channel === 'hosts:models')
    return { models, ...(hostDefaults ? { defaults: hostDefaults } : {}) }
  if (channel === 'hosts:providers') return providers
  if (channel === 'pi:agentSettings') return MAC_SETTINGS
  throw new Error(`unexpected ${channel}`)
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  invoke.mockClear()
  hostDefaults = undefined
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  useRemoteLanesStore.setState({ hosts: {} })
  useMachineCataloguesStore.setState({ catalogues: {} })
  vi.unstubAllGlobals()
})

function Selection() {
  const { model, thinking, explanation } = useRemoteModel(MOCK_HOST_ID)
  return <p>{`${model?.id ?? 'none'}|${thinking}|${explanation}`}</p>
}
async function chosen(platform: typeof DESKTOP_PLATFORM) {
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <Selection />
      </PlatformProvider>,
    ),
  )
  await act(async () => new Promise((done) => setTimeout(done, 0)))
  const [model, thinking, explanation] = (container.textContent ?? '').split('|')
  return { model, thinking, explanation }
}
const remember = (id: string) =>
  useRemoteModelPicks.setState({
    last: { [MOCK_HOST_ID]: { provider: id === 'blocked' ? 'off' : 'p', id } },
    thinking: { [MOCK_HOST_ID]: 'low' },
  })

it.each(ALL)('keeps the last usable choice first (localLanes: $localLanes)', async (platform) => {
  hostDefaults = { model: { provider: 'p', id: 'host' }, thinkingLevel: 'high' }
  remember('last')
  expect(await chosen(platform)).toEqual({
    model: 'last',
    thinking: 'low',
    explanation: 'Using your last selected model for this machine.',
  })
})

it.each(ALL)(
  'starts on the Host’s usable default, ahead of This Mac’s, when the last choice is unusable (localLanes: $localLanes)',
  async (platform) => {
    hostDefaults = { model: { provider: 'p', id: 'host' }, thinkingLevel: 'high' }
    remember('blocked')
    useRemoteModelPicks.setState({ thinking: {} })
    expect(await chosen(platform)).toEqual({
      model: 'host',
      thinking: 'high',
      explanation: 'Using this Host’s default model.',
    })
  },
)

it('falls through an unusable Host default to This Mac’s on Desktop', async () => {
  hostDefaults = { model: { provider: 'off', id: 'blocked' } }
  expect(await chosen(DESKTOP_PLATFORM)).toEqual({
    model: 'mac',
    thinking: 'minimal',
    explanation: 'Using the Desktop default, available on this machine.',
  })
})

it.each(BROWSERS)(
  'falls through an unusable Host default to the first usable model in the browser (formFactor: $formFactor)',
  async (platform) => {
    hostDefaults = { model: { provider: 'off', id: 'blocked' }, thinkingLevel: 'medium' }
    expect(await chosen(platform)).toEqual({
      model: 'first',
      thinking: 'medium',
      explanation:
        'This Host’s default model is not available. Using the first available model; choose another if needed.',
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('pi:agentSettings')
  },
)

it('uses This Mac’s default on Desktop when the Host reports none', async () => {
  expect(await chosen(DESKTOP_PLATFORM)).toMatchObject({ model: 'mac', thinking: 'minimal' })
})

it.each(BROWSERS)(
  'uses the first usable model in the browser when the Host reports no default (formFactor: $formFactor)',
  async (platform) => {
    expect(await chosen(platform)).toEqual({
      model: 'first',
      thinking: 'off',
      explanation:
        'This Host reports no default model. Using the first available model; choose another if needed.',
    })
  },
)
