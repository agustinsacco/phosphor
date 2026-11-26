// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./MessageList', () => ({ MessageList: () => null }))
vi.mock('@/features/extension-ui/StatusStrip', () => ({ StatusStrip: () => null }))

const { installMockPhosphor } = await import('@/dev/mockPhosphor')
installMockPhosphor()
const { useChatStore } = await import('@/stores/chat')
const { composerDraftKey, useDraftsStore } = await import('@/stores/drafts')
const { useSessionsStore } = await import('@/stores/sessions')
const { machineLabel, REMOTE_NOT_READY, useRemoteLanesStore } = await import('@/stores/remoteLanes')
const { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
const { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } =
  await import('@/platform/Platform')
const { ChatView } = await import('./ChatView')

/*
 * A booting local service accepts the socket before its lanes start and grants
 * nothing yet. Its lanes stay listed from the last snapshot, but the machine is
 * starting, not ready: the composer waits, says so, and nothing is sent. The
 * same on Desktop and in the browser.
 */
const SESSION = mockRemoteInfo.sessionId
const SHELLS = [
  ['Desktop', DESKTOP_PLATFORM],
  ['a wide browser', WIDE_BROWSER_PLATFORM],
  ['a phone', COMPACT_PLATFORM],
] as const

let root: Root | null = null
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  el.remove()
  vi.restoreAllMocks()
})

function startingService(local: boolean): void {
  const { hosts, live } = hostLaneSession({ activity: 'stopped', self: true })
  const host = hosts[MOCK_HOST_ID]!
  if (local) host.local = true
  host.capabilities = []
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(SESSION)
  const entry = useSessionsStore.getState().live[SESSION]
  useDraftsStore.getState().setText(composerDraftKey(entry, SESSION), 'hello')
}

describe.each(SHELLS)('a lane on a starting machine on %s', (_shell, platform) => {
  it.each([
    ['This Mac’s service', true],
    ['a remote Host', false],
  ])('on %s waits locked and sends nothing', (_machine, local) => {
    startingService(local)
    const piCommand = vi.spyOn(window.phosphor, 'piCommand')
    const invoke = vi.spyOn(window.phosphor, 'invoke')
    root = createRoot(el)
    act(() =>
      root!.render(
        <PlatformProvider value={platform}>
          <ChatView sessionId={SESSION} workspacePath={mockRemoteInfo.workspacePath} />
        </PlatformProvider>,
      ),
    )
    expect(el.textContent).not.toContain('Read-only')
    expect(el.textContent).not.toContain('Take control')
    // Only This Mac's service has a boot window. An enrolled Host that grants nothing
    // is unavailable, not starting: it would otherwise spin forever.
    const starting = `Starting ${machineLabel(MOCK_HOST_ID)}…`
    if (local) expect(el.textContent).toContain(starting)
    else expect(el.textContent).toContain(REMOTE_NOT_READY)
    if (!local) expect(el.textContent).not.toContain(starting)
    expect(!!el.querySelector('[role=status] .phosphor-loader')).toBe(local)
    const fieldset = el.querySelector('fieldset')
    expect(fieldset?.disabled).toBe(true)
    expect(fieldset?.getAttribute('aria-busy') ?? null).toBe(local ? 'true' : null)

    const input = el.querySelector<HTMLTextAreaElement>('[data-composer-input]')!
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      el.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click()
    })
    expect(piCommand).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContainEqual(
      expect.stringMatching(/^hosts:(takeControl|resumeLane|startLane)/),
    )
  })
})
