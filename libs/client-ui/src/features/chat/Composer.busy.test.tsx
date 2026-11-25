// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostResourceKey } from '@shared/remote-host'
import type { RpcCommand } from '@shared/rpc'
import { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { installMockPhosphor } from '@/dev/mockPhosphor'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { sessionDraftKey, useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { Composer } from './Composer'

const id = mockRemoteInfo.sessionId
const hostKey = hostResourceKey(
  { kind: 'remote', hostId: MOCK_HOST_ID },
  'session',
  mockRemoteInfo.laneId ?? '',
)
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  installMockPhosphor()
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(id)
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useExtensionUiStore.setState({ widgets: {}, dialogs: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  useDraftsStore.setState({ drafts: {} })
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useExtensionUiStore.setState({ widgets: {}, dialogs: [] })
})

function hostLane(activity: 'idle' | 'working') {
  const { hosts, live } = hostLaneSession({ activity, self: true })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  useDraftsStore.setState({ drafts: { [hostKey]: { text: 'PHX-busy', attachments: [] } } })
}

function delegatedLane() {
  useDraftsStore.setState({
    drafts: { [sessionDraftKey(undefined, id)]: { text: 'PHX-busy', attachments: [] } },
  })
  useExtensionUiStore.setState({
    widgets: {
      [id]: {
        'subagent-async': {
          placement: 'aboveEditor',
          lines: [
            'PI_SUBAGENT_ASYNC_JSON:' +
              JSON.stringify({
                kind: 'pi-subagents.async-status-snapshot',
                version: 1,
                runs: [{ id: 'run', label: 'Reviewer', state: 'running', children: [] }],
              }),
          ],
        },
      },
    },
  })
}

async function draw() {
  await act(async () =>
    root.render(<Composer sessionId={id} workspacePath={mockRemoteInfo.workspacePath} />),
  )
}
const button = (name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  )
const prompts = (pi: { mock: { calls: unknown[][] } }) =>
  pi.mock.calls.map(([, command]) => command as RpcCommand).filter((c) => c.type === 'prompt')

async function enter(modifiers: KeyboardEventInit = {}) {
  const textarea = container.querySelector('textarea')
  await act(async () =>
    textarea?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...modifiers }),
    ),
  )
}

it.each([
  ['a Host lane its Host reports working', () => hostLane('working')],
  ['a lane whose background agents still run', delegatedLane],
])('offers Steer now and Queue follow-up, and Enter steers, on %s', async (_, arrange) => {
  arrange()
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  await draw()
  expect(useChatStore.getState().sessions[id]?.isStreaming).toBe(false)
  expect(button('Steer now')).toBeDefined()
  expect(button('Queue follow-up')).toBeDefined()
  expect(container.querySelector('textarea')?.placeholder).not.toBe('Describe a task…')
  await enter()
  expect(prompts(pi)).toEqual([{ type: 'prompt', message: 'PHX-busy', streamingBehavior: 'steer' }])
})

it('the Send button steers and a modified Enter queues while the Host reports the lane working', async () => {
  hostLane('working')
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  await draw()
  await act(async () => button('Send message')?.click())
  act(() => useDraftsStore.getState().setText(hostKey, 'PHX-later'))
  await enter({ altKey: true })
  expect(prompts(pi)).toEqual([
    { type: 'prompt', message: 'PHX-busy', streamingBehavior: 'steer' },
    { type: 'prompt', message: 'PHX-later', streamingBehavior: 'followUp' },
  ])
})

it('an idle Host lane offers neither and sends Enter with a follow-up fallback', async () => {
  hostLane('idle')
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  await draw()
  expect(button('Steer now')).toBeUndefined()
  expect(button('Queue follow-up')).toBeUndefined()
  await enter()
  expect(prompts(pi)).toEqual([
    { type: 'prompt', message: 'PHX-busy', streamingBehavior: 'followUp' },
  ])
})

it.each(['idle', 'working'] as const)(
  'keeps the draft editable but cannot send during compaction (%s)',
  async (activity) => {
    hostLane(activity)
    const pi = vi.spyOn(window.phosphor, 'piCommand').mockResolvedValue({
      type: 'response',
      command: 'prompt',
      success: false,
      error:
        'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.',
    })
    act(() =>
      useChatStore.getState().applyEvent(id, { type: 'compaction_start', reason: 'manual' }),
    )
    await draw()
    expect(container.querySelector('textarea')?.matches(':disabled')).toBe(false)
    expect(container.querySelector('textarea')?.placeholder).toMatch(/compaction.*send/i)
    expect(button('Steer now')).toBeUndefined()
    expect(button('Queue follow-up')).toBeUndefined()
    expect(button('Send message')?.disabled).toBe(true)
    await enter()
    await enter({ altKey: true })
    expect(prompts(pi)).toEqual([])
    expect(useDraftsStore.getState().get(hostKey).text).toBe('PHX-busy')
  },
)

it('accepts a follow-up draft on a live Host before the first prompt is acknowledged', async () => {
  hostLane('idle')
  let acceptFirst!: () => void
  const pi = vi.spyOn(window.phosphor, 'piCommand').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acceptFirst = () => resolve({ type: 'response', command: 'prompt', success: true })
      }),
  )
  await draw()
  await enter()
  expect(container.querySelector('textarea')?.matches(':disabled')).toBe(false)
  act(() => useDraftsStore.getState().setText(hostKey, 'PHX-second'))
  expect(button('Queue follow-up')?.matches(':disabled')).toBe(false)
  await act(async () => button('Queue follow-up')?.click())
  expect(prompts(pi)).toEqual([
    { type: 'prompt', message: 'PHX-busy', streamingBehavior: 'followUp' },
  ])
  await act(async () => acceptFirst())
  expect(prompts(pi)).toEqual([
    { type: 'prompt', message: 'PHX-busy', streamingBehavior: 'followUp' },
    { type: 'prompt', message: 'PHX-second', streamingBehavior: 'followUp' },
  ])
})

it('Queue follow-up treats a shell-looking draft as a message, not an immediate bash command', async () => {
  delegatedLane()
  act(() => useDraftsStore.getState().setText(sessionDraftKey(undefined, id), '!pwd'))
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  await draw()
  await act(async () => button('Queue follow-up')?.click())
  expect(pi.mock.calls.map(([, command]) => command)).not.toContainEqual(
    expect.objectContaining({ type: 'bash' }),
  )
  expect(prompts(pi)).toEqual([{ type: 'prompt', message: '!pwd', streamingBehavior: 'followUp' }])
})
