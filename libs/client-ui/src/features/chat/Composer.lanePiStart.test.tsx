// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import type { Model, RpcCommand, RpcResponse } from '@shared/rpc'

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
const { bootstrapSession, forgetRemoteSession, useSessionsStore } =
  await import('@/stores/sessions')
const { navigateToLane, useRemoteLanesStore } = await import('@/stores/remoteLanes')
const { runLaneAction } = await import('@/platform/serviceLaneControl')
const { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
const { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } =
  await import('@/platform/Platform')
const { Composer } = await import('./Composer')

/*
 * Opening a stopped Host lane adopts it before its pi exists: the Host refuses
 * its state and models. When the lane's pi comes up (This Mac warms it on open,
 * any Host starts it on the first prompt or Resume), the picker turns live by
 * itself, the same on Desktop and in the browser.
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
const SHELLS = [
  ['Desktop', DESKTOP_PLATFORM],
  ['a wide browser', WIDE_BROWSER_PLATFORM],
  ['a phone', COMPACT_PLATFORM],
] as const

let root: Root | null = null
let el: HTMLDivElement
const piCommand = vi.spyOn(window.phosphor, 'piCommand')
const reads = (type: RpcCommand['type']) =>
  piCommand.mock.calls.filter(([, command]) => command.type === type).length

/** The Host's connection is gone: every read fails. */
let hostDown = false
/** A Host that answers like the real one: nothing about the lane's pi until it runs. */
function answerLikeHost(): void {
  piCommand.mockImplementation((_id, command) => {
    const running = !lane()?.activity || !['stopped', 'failed'].includes(lane()!.activity)
    const answer = (reply: Partial<RpcResponse>) =>
      Promise.resolve({ type: 'response', command: command.type, ...reply } as never)
    if (hostDown) return answer({ success: false, error: 'Host unavailable.' })
    if (command.type === 'get_messages') return answer({ success: true, data: { messages: [] } })
    if (!running) return answer({ success: false, error: 'Lane is stopped.' })
    if (command.type === 'get_state') return answer({ success: true, data: META })
    if (command.type === 'get_available_models')
      return answer({ success: true, data: { models: [OPUS] } })
    return answer({ success: false, error: 'Unsupported.' })
  })
}
const lane = (): HostLaneView | undefined =>
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]?.lanes[0]

function stoppedHost(local: boolean): void {
  const { hosts } = hostLaneSession({ activity: 'stopped', self: true })
  const host = hosts[MOCK_HOST_ID]!
  if (local) Object.assign(host, { local: true })
  else Object.assign(host, { warmOnOpen: false })
  host.lanes[0] = { ...host.lanes[0]!, model: { provider: OPUS.provider, id: OPUS.id } }
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live: {} })
  useChatStore.setState({ sessions: {} })
}
function setHost(state: 'ready' | 'reconnecting', connectionToken: string): void {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  Object.assign(hosts[MOCK_HOST_ID]!, { state, connectionToken })
  useRemoteLanesStore.setState({ hosts })
}
function setActivity(activity: HostLaneView['activity']): void {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes[0] = { ...host.lanes[0]!, activity }
  useRemoteLanesStore.setState({ hosts })
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(() => Promise.resolve())
}
async function openLane(): Promise<void> {
  await act(() =>
    useSessionsStore
      .getState()
      .adoptSession(SESSION, mockRemoteInfo.workspacePath, undefined, mockRemoteInfo),
  )
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
  hostDown = false
  piCommand.mockReset()
  answerLikeHost()
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(async () => {
  if (root) act(() => root!.unmount())
  root = null
  el.remove()
  await act(() => forgetRemoteSession(SESSION))
})

describe.each(SHELLS)('a stopped Host lane’s model picker on %s', (_shell, platform) => {
  it.each([
    ['This Mac’s service, warmed on open', true, 'idle'],
    ['a remote Host, started by the first prompt', false, 'working'],
  ] as const)('on %s turns live when the lane’s pi comes up', async (_m, local, activity) => {
    stoppedHost(local)
    await openLane()
    render(platform)
    expect(chip()?.disabled).toBe(true)
    expect(chip()?.getAttribute('data-tooltip')).toBe('Starts with the lane')

    act(() => setActivity(activity))
    await settle()
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.textContent).toBe(OPUS.name)
    act(() => chip()!.click())
    expect(document.querySelector('[data-testid=model-list]')?.textContent).toContain(OPUS.name)
  })
})

describe.each(SHELLS)('the starts that bring a lane’s pi up on %s', (_shell, platform) => {
  /** The Host starts the lane's pi; its next snapshot shows the lane running. */
  function hostStartsLanes(): void {
    const invoke = window.phosphor.invoke.bind(window.phosphor) as (
      channel: string,
      ...args: unknown[]
    ) => Promise<unknown>
    vi.spyOn(window.phosphor, 'invoke').mockImplementation(((
      channel: string,
      ...args: unknown[]
    ) => {
      if (channel === 'hosts:openLane') return Promise.resolve(mockRemoteInfo)
      if (channel === 'hosts:snapshot')
        return Promise.resolve(structuredClone(useRemoteLanesStore.getState().hosts))
      if (channel === 'hosts:resumeLane') {
        setActivity('idle')
        return Promise.resolve()
      }
      return invoke(channel, ...args)
    }) as typeof window.phosphor.invoke)
  }
  afterEach(() => vi.mocked(window.phosphor.invoke).mockRestore())

  it('This Mac’s warm on open', async () => {
    stoppedHost(true)
    Object.assign(useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!, { warmOnOpen: true })
    hostStartsLanes()
    await act(() => navigateToLane({ hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! }))
    render(platform)
    await settle()
    expect(lane()?.activity).toBe('idle')
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.textContent).toBe(OPUS.name)
  })

  it('Resume from the lane menu on a remote Host', async () => {
    stoppedHost(false)
    await openLane()
    render(platform)
    expect(chip()?.disabled).toBe(true)
    hostStartsLanes()
    await act(() => runLaneAction('hosts:resumeLane', MOCK_HOST_ID, mockRemoteInfo.laneId!))
    await settle()
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.textContent).toBe(OPUS.name)
  })
})

describe('re-reading a lane whose pi comes up', () => {
  it('reads once per start, never stacks reads, and leaves the transcript alone', async () => {
    stoppedHost(true)
    await openLane()
    const before = { state: reads('get_state'), messages: reads('get_messages') }
    act(() => {
      setActivity('idle')
      setActivity('working')
      setActivity('needs-input')
    })
    await settle()
    expect(reads('get_state') - before.state).toBe(1)
    expect(reads('get_messages')).toBe(before.messages)
    expect(useChatStore.getState().sessions[SESSION]?.meta?.model?.id).toBe(OPUS.id)

    // A restart during a read waits for it, then reads once more.
    const afterFirst = reads('get_state')
    act(() => {
      setActivity('stopped')
      setActivity('idle')
      setActivity('failed')
      setActivity('idle')
      setActivity('stopped')
      setActivity('idle')
    })
    expect(reads('get_state') - afterFirst).toBe(1)
    await settle()
    expect(reads('get_state') - afterFirst).toBe(2)
  })

  it('reads again when the Host is back, if the start’s reads failed', async () => {
    stoppedHost(false)
    await openLane()
    render(DESKTOP_PLATFORM)
    // The client sees the start, then loses the Host before the reads land.
    hostDown = true
    act(() => setActivity('idle'))
    await settle()
    expect(chip()?.disabled).toBe(true)
    act(() => setHost('reconnecting', 'mock-connection-1'))
    hostDown = false
    // A reconnect replays no start: the lane already ran in the last snapshot.
    act(() => setHost('ready', 'mock-connection-2'))
    await settle()
    expect(chip()?.disabled).toBe(false)
    expect(chip()?.textContent).toBe(OPUS.name)

    // A lane whose reads all landed is not read again on a reconnect.
    const before = reads('get_state')
    act(() => setHost('reconnecting', 'mock-connection-2'))
    act(() => setHost('ready', 'mock-connection-3'))
    await settle()
    expect(reads('get_state')).toBe(before)
  })

  it('shares one read between adoption, a stream reset and the start', async () => {
    stoppedHost(true)
    await openLane()
    const before = { state: reads('get_state'), models: reads('get_available_models') }
    await act(async () => {
      setActivity('idle')
      // The stream reset that pi's start sends bootstraps the lane too.
      await Promise.all([bootstrapSession(SESSION), bootstrapSession(SESSION)])
    })
    await settle()
    expect(reads('get_state') - before.state).toBe(1)
    expect(reads('get_available_models') - before.models).toBe(1)
    expect(useChatStore.getState().sessions[SESSION]?.meta?.model?.id).toBe(OPUS.id)
  })

  it('reads afresh for a caller that needs a new identity, after the read in flight', async () => {
    stoppedHost(true)
    await openLane()
    const before = reads('get_state')
    await act(async () => {
      // The start's read is in flight; a plain caller joins it, a fresh one waits for it.
      setActivity('idle')
      const shared = bootstrapSession(SESSION)
      const fresh = bootstrapSession(SESSION, { fresh: true })
      expect(reads('get_state') - before).toBe(1)
      await Promise.all([shared, fresh])
    })
    await settle()
    expect(reads('get_state') - before).toBe(2)
  })

  it('ignores a lane closed before its pi comes up', async () => {
    stoppedHost(false)
    await openLane()
    await act(() => forgetRemoteSession(SESSION))
    const before = reads('get_state')
    act(() => setActivity('idle'))
    await settle()
    expect(reads('get_state')).toBe(before)
  })
})
