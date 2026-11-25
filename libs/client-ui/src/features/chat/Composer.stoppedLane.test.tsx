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

function stoppedLane(local: boolean): void {
  const { hosts, live } = hostLaneSession({ activity: 'stopped', self: true })
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
      useChatStore.getState().setModels(SESSION, [OPUS])
      useChatStore.getState().setMeta(SESSION, {
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
      })
    })
    expect(chip()?.textContent).toBe(OPUS.name)
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.parentElement).toBe(picker)
  })
})
