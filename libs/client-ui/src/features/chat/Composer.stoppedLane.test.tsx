// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model } from '@shared/rpc'

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { installMockPhosphor } = await import('@/dev/mockPhosphor')
installMockPhosphor()
const { useChatStore } = await import('@/stores/chat')
const { useSessionsStore } = await import('@/stores/sessions')
const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
const { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
const { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } =
  await import('@/platform/Platform')
const { Composer } = await import('./Composer')
const { formatTokens } = await import('@/lib/format')

/*
 * A lane that is stopped, or still starting, has no live pi to describe its
 * model. Its composer keeps the bar's shape from the lane's recorded model, the
 * same on Desktop and in the browser, and the live chip takes the same place.
 */
const SESSION = mockRemoteInfo.sessionId
const OPUS: Model = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  api: 'pi-claude-cli',
  provider: 'pi-claude-cli',
  reasoning: false,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const SHELLS = [
  ['Desktop', DESKTOP_PLATFORM],
  ['a wide browser', WIDE_BROWSER_PLATFORM],
  ['a phone', COMPACT_PLATFORM],
] as const

let root: Root | null = null
let el: HTMLDivElement

function stoppedLane(local: boolean, activity: 'stopped' | 'idle' = 'stopped'): void {
  const { hosts, live } = hostLaneSession({ activity, self: true })
  const host = hosts[MOCK_HOST_ID]!
  if (local) host.local = true
  host.lanes[0] = { ...host.lanes[0]!, model: { provider: OPUS.provider, id: OPUS.id } }
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(SESSION)
}
function render(platform: (typeof SHELLS)[number][1]): void {
  root = createRoot(el)
  act(() =>
    root!.render(
      <PlatformProvider value={platform}>
        <Composer sessionId={SESSION} workspacePath={mockRemoteInfo.workspacePath} />
      </PlatformProvider>,
    ),
  )
}
const chip = () => el.querySelector<HTMLButtonElement>('[data-testid=model-chip]')
const readout = () => el.querySelector('[data-testid=context-readout]')
const META = {
  model: OPUS,
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionId: SESSION,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
} as const
const STATS = {
  sessionId: SESSION,
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
  cost: 0,
  contextUsage: { tokens: 72_000, contextWindow: 200_000, percent: 36 },
}
function setActivity(activity: 'stopped' | 'idle'): void {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes[0] = { ...host.lanes[0]!, activity }
  useRemoteLanesStore.setState({ hosts })
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  el.remove()
})

describe.each(SHELLS)('a stopped Host lane’s composer on %s', (_shell, platform) => {
  it.each([
    ['This Mac’s service', true],
    ['a remote Host', false],
  ])('on %s shows the recorded model, quietly, in the live chip’s place', (_machine, local) => {
    stoppedLane(local)
    render(platform)
    const recorded = chip()
    expect(recorded?.textContent).toBe(OPUS.id)
    expect(recorded?.disabled).toBe(true)
    expect(recorded?.getAttribute('data-tooltip')).toBe('Starts with the lane')
    expect(el.querySelector('[data-testid=context-meter-idle]')).not.toBeNull()
    expect(el.querySelector('[data-testid=context-sources]')).not.toBeNull()
    const picker = recorded?.parentElement

    act(() => {
      setActivity('idle')
      useChatStore.getState().setModels(SESSION, [OPUS])
      useChatStore.getState().setMeta(SESSION, META)
    })
    expect(chip()?.textContent).toBe(OPUS.name)
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.parentElement).toBe(picker)
  })

  it.each([
    ['This Mac’s service', true],
    ['a remote Host', false],
  ])('on %s, stopping an open lane shows the idle chips over its last state', (_m, local) => {
    stoppedLane(local, 'idle')
    act(() => {
      useChatStore.getState().setModels(SESSION, [OPUS])
      useChatStore.getState().setMeta(SESSION, META)
      useChatStore.getState().setStats(SESSION, STATS)
    })
    render(platform)
    expect(chip()?.disabled).toBe(false)
    expect(el.querySelector('[data-testid=context-meter]')).not.toBeNull()

    act(() => setActivity('stopped'))
    expect(chip()?.disabled).toBe(true)
    expect(chip()?.getAttribute('data-tooltip')).toBe('Starts with the lane')
    expect(el.querySelector('[data-testid=context-meter]')).toBeNull()
    expect(el.querySelector('[data-testid=context-meter-idle]')).not.toBeNull()
  })

  it.each([
    ['This Mac’s service', true],
    ['a remote Host', false],
  ])(
    'on %s, a lane running again shows the live chips, as the chat store holds them',
    (_m, local) => {
      stoppedLane(local, 'idle')
      act(() => {
        useChatStore.getState().setModels(SESSION, [OPUS])
        useChatStore.getState().setMeta(SESSION, META)
        useChatStore.getState().setStats(SESSION, STATS)
      })
      render(platform)
      act(() => setActivity('stopped'))
      expect(chip()?.disabled).toBe(true)
      act(() => setActivity('idle'))
      expect(chip()?.disabled).toBe(false)
      expect(el.querySelector('[data-testid=context-meter]')).not.toBeNull()
    },
  )

  it('gives the readout a fixed slot sized for its widest live state', () => {
    stoppedLane(true)
    render(platform)
    const slot = readout()
    const reserve = slot?.querySelector('[data-readout-reserve]')
    expect(reserve?.getAttribute('aria-hidden')).toBe('true')
    // Whatever shows sits over the reserve, out of flow, so it never sizes the slot.
    const layer = slot?.querySelector('[data-readout-layer]')
    expect(layer?.classList.contains('absolute')).toBe(true)
    expect(layer?.querySelector('[data-testid=context-meter-idle]')).not.toBeNull()

    act(() => {
      setActivity('idle')
      useChatStore.getState().setMeta(SESSION, META)
      useChatStore.getState().setStats(SESSION, STATS)
    })
    expect(readout()).toBe(slot)
    expect(slot?.querySelector('[data-readout-reserve]')).toBe(reserve)
    expect(layer?.querySelector('[data-testid=context-meter]')).not.toBeNull()
  })

  it('lets the usage popover wrap: only the inline readout keeps to one line', () => {
    stoppedLane(true, 'idle')
    act(() => {
      useChatStore.getState().setMeta(SESSION, META)
      useChatStore.getState().setStats(SESSION, STATS)
    })
    render(platform)
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid=context-meter]')!
    expect(trigger.classList.contains('whitespace-nowrap')).toBe(true)
    // The popover reads the Host's Claude plan usage; nothing answers it here.
    const invoke = vi.spyOn(window.phosphor, 'invoke').mockResolvedValue(null)
    act(() => trigger.click())
    invoke.mockRestore()
    const heading = [...document.querySelectorAll('span')].find(
      (span) => span.textContent === 'Session usage',
    )
    expect(heading).toBeDefined()
    for (let node = heading?.parentElement; node && node !== el; node = node.parentElement)
      expect(node.classList.contains('whitespace-nowrap')).toBe(false)
  })

  it('reserves room for the widest readout the largest supported budget produces', () => {
    const budget = 999_900 // `999.9k`, which formats as `1000k`
    stoppedLane(true, 'idle')
    act(() => {
      useChatStore.getState().setMeta(SESSION, META)
      useChatStore.getState().setStats(SESSION, {
        ...STATS,
        contextUsage: { tokens: budget, contextWindow: budget, percent: 100 },
      })
    })
    render(platform)
    const [reading, burn] = [...el.querySelectorAll('[data-readout-reserve] > span')].map(
      (span) => span.textContent ?? '',
    )
    const live = el.querySelector('[data-testid=context-meter] > span')?.textContent ?? ''
    expect(live).toBe(`100% of ${formatTokens(budget)}`)
    expect(reading!.length).toBeGreaterThanOrEqual(live.length)
    // Over budget, the percentage grows a digit at most; the burn rate is a token count per minute.
    expect(reading!.length).toBeGreaterThanOrEqual(`999% of ${formatTokens(budget)}`.length)
    expect(burn!.length).toBeGreaterThanOrEqual(`${formatTokens(budget)}/min`.length)
  })
})
