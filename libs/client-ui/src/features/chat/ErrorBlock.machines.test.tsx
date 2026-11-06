// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ErrorBlock } from './MessageItem'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { localMachineLabel } from '@/lib/localMachine'
import { hostLaneSession, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

/** One remedy set on every machine; only where the fix runs differs. */

vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <span>{text}</span>,
}))

const MACHINES = ['mac', 'host'] as const
type Machine = (typeof MACHINES)[number]

let root: Root
let el: HTMLDivElement
let navigate: ReturnType<typeof vi.fn<(next: Location) => void>>
let piCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  navigate = vi.fn<(next: Location) => void>()
  piCommand = vi.fn(async () => ({ success: true }))
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => ({})), piCommand })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useRemoteLanesStore.setState({ hosts: {} })
  useChatStore.setState({ sessions: {} })
  vi.unstubAllGlobals()
})

/** A lane on `machine` whose last turn failed with `message`, idle and controlled here. */
async function failedTurn(machine: Machine, message: string): Promise<void> {
  const sessionId = machine
  if (machine === 'host') {
    const { hosts, live } = hostLaneSession({ self: true, capabilities: ['terminal'], sessionId })
    useRemoteLanesStore.setState({ hosts })
    useSessionsStore.setState({ activeSessionId: sessionId, live })
  } else {
    useSessionsStore.setState({
      activeSessionId: sessionId,
      live: { [sessionId]: { phosphorId: sessionId, sessionId, workspacePath: '/mac' } },
    })
  }
  useChatStore.getState().ensure(sessionId)
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [sessionId]: {
        ...s.sessions[sessionId]!,
        isStreaming: false,
        items: [
          { id: 'u', kind: 'user', text: 'retry me' },
          {
            id: 'a',
            kind: 'assistant',
            streaming: false,
            blocks: [],
            stopReason: 'error',
            errorMessage: message,
          },
        ],
      },
    },
  }))
  await act(async () =>
    root.render(
      <NavigationProvider value={{ location: { to: 'home' } as never, navigate }}>
        <ErrorBlock sessionId={sessionId} message={message} />
      </NavigationProvider>,
    ),
  )
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === label)

it.each(MACHINES)(
  '%s: an expired AWS token offers aws sso login in the lane terminal',
  async (m) => {
    await failedTurn(m, 'Token is expired, run aws sso login')
    expect(el.querySelector('code')?.textContent ?? '').toMatch(/^aws sso login/)
    expect(button('Run aws sso login')?.textContent).toBe('Run aws sso login')
  },
)

it.each(MACHINES)('%s: a failed turn the fix needs retried offers Retry', async (m) => {
  await failedTurn(m, 'Token is expired, run aws sso login')
  const retry = button('Retry failed turn')
  expect(retry?.textContent).toBe('Retry failed turn')
  await act(async () => retry?.click())
  expect(piCommand).toHaveBeenCalledWith(m, expect.objectContaining({ type: 'prompt' }))
})

it.each(MACHINES)("%s: sign-in opens Settings → Accounts for the lane's machine", async (m) => {
  await failedTurn(m, 'OAuth refresh token rejected')
  const label = m === 'host' ? MOCK_HOST_ID : localMachineLabel()
  const signIn = button(`Sign in on ${label}`)
  expect(signIn?.textContent).toBe(`Sign in on ${label}`)
  act(() => signIn?.click())
  expect(useSettingsUiStore.getState().tab).toBe('accounts')
  expect(navigate).toHaveBeenCalledWith({
    to: 'page',
    page: 'settings',
    machine: m === 'host' ? MOCK_HOST_ID : 'local',
  })
})

it.each([
  ['loses control', { control: { fence: 1, controller: null } }],
  ['starts a turn', { activity: 'working' }],
] as const)('host: Retry leaves as soon as the lane %s', async (_, change) => {
  await failedTurn('host', 'Token is expired, run aws sso login')
  expect(button('Retry failed turn')).toBeDefined()
  act(() => {
    const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
    hosts[MOCK_HOST_ID]!.lanes[0] = { ...hosts[MOCK_HOST_ID]!.lanes[0]!, ...change }
    useRemoteLanesStore.setState({ hosts })
  })
  expect(button('Retry failed turn')).toBeUndefined()
})
