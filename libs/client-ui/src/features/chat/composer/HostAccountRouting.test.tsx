// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HostAccountRouting } from './HostAccountRouting'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { usePromptStore } from '@/stores/prompt'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import type { HostCapability } from '@shared/remote-host'
import type { MachineAccount } from '@shared/machine-settings'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const SESSION = 'remote-sess'
const LANE = mockRemoteInfo.laneId!

const account = (id: string, lanes: string[], extra: Partial<MachineAccount> = {}) => ({
  id,
  label: id,
  loggedIn: true,
  cooldownUntil: null,
  usage: null,
  lanes: lanes.map((laneId) => ({ id: laneId, title: 'lane', active: true })),
  ...extra,
})

let accounts: MachineAccount[] = []
const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
  if (channel === 'hosts:settingsRead')
    return { section: 'providers', revision: 'r1', providers: { accounts } }
  return undefined
})

let root: Root | null = null
let container: HTMLDivElement | null = null
const onMoved = vi.fn()

function host(capabilities: HostCapability[], self = true) {
  const base = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...base,
        configurationSupported: true,
        capabilities,
        lanes: base.lanes.map((lane) => ({
          ...lane,
          control: { fence: 1, controller: { label: 'This Mac', connected: true, self } },
        })),
      },
    },
  })
}

/** A fresh Host connection: not ready, and not yet saying what it supports. */
function reconnecting(): void {
  const current = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...current,
        state: 'connecting',
        capabilities: [],
        lanes: [],
        configurationSupported: undefined,
      },
    },
  })
}

const FULL: HostCapability[] = ['sessions.read', 'sessions.control', 'machine.configure']

async function answerPrompt(value: string | undefined): Promise<void> {
  const request = usePromptStore.getState().requests[0]
  if (!request) throw new Error('no prompt')
  await act(async () => usePromptStore.getState().dismiss(request, value))
}

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<HostAccountRouting sessionId={SESSION} onMoved={onMoved} />))
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  )
  if (!button) throw new Error(`no button "${label}" in: ${document.body.textContent}`)
  act(() => button.click())
}

beforeEach(() => {
  ;(window as unknown as { phosphor: unknown }).phosphor = { invoke }
  const { workspacePath, target } = mockRemoteInfo
  useSessionsStore.setState({
    live: { [SESSION]: { phosphorId: SESSION, workspacePath, target, laneId: LANE } },
  })
  accounts = [
    account('work', [LANE], { email: 'work@example.com' }),
    account('personal', [], { email: 'personal@example.com' }),
    account('signed-out', [], { loggedIn: false }),
  ]
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  invoke.mockClear()
  onMoved.mockClear()
  usePromptStore.setState({ requests: [] })
})

it('reads nothing until the picker opens, then moves the Host lane to another account', async () => {
  host(['sessions.read', 'sessions.control', 'machine.configure'])
  render()
  expect(invoke).not.toHaveBeenCalled()
  click('Switch account')
  await act(async () => {})
  expect(invoke).toHaveBeenCalledWith('hosts:settingsRead', MOCK_HOST_ID, 'providers')
  // The lane's own account and signed-out accounts are not targets.
  expect(document.body.textContent).toContain('personal@example.com')
  expect(document.body.textContent).not.toContain('signed-out')
  click('personal@example.com')
  await act(async () => {})
  expect(invoke).toHaveBeenCalledWith('hosts:claudeAccount', MOCK_HOST_ID, LANE, 'personal')
  expect(onMoved).toHaveBeenCalled()
})

it('says so when the Host has no other signed-in account', async () => {
  host(['sessions.read', 'sessions.control', 'machine.configure'])
  accounts = [account('work', [LANE])]
  render()
  click('Switch account')
  await act(async () => {})
  expect(document.body.textContent).toContain('No other signed-in Claude account')
})

it('asks for settings access before reading Host accounts', async () => {
  host(['sessions.read', 'sessions.control'])
  render()
  click('Switch account')
  await act(async () => {})
  expect(usePromptStore.getState().requests.length).toBe(1)
  expect(invoke).not.toHaveBeenCalledWith('hosts:settingsRead', MOCK_HOST_ID, 'providers')
})

it('needs lane control before offering a move', () => {
  host(['sessions.read', 'machine.configure'])
  render()
  expect(document.body.textContent).toContain('Take control of this lane')
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Switch account'),
  )
  expect(button?.disabled).toBe(true)
})

it('surfaces a failed move instead of swallowing it', async () => {
  host(['sessions.read', 'sessions.control', 'machine.configure'])
  invoke.mockImplementationOnce(async () => ({
    section: 'providers',
    revision: 'r1',
    providers: { accounts },
  }))
  invoke.mockImplementationOnce(async () => {
    throw new Error('Account move not confirmed.')
  })
  render()
  click('Switch account')
  await act(async () => {})
  click('personal@example.com')
  await act(async () => {})
  expect(document.body.textContent).toContain('Account move not confirmed.')
  // The Host may have moved the lane before the link changed: usage is re-read.
  expect(onMoved).toHaveBeenCalled()
})

it('keeps the picker open through the reconnect a granted access causes, then reads', async () => {
  host(['sessions.read', 'sessions.control'])
  render()
  click('Switch account')
  await act(async () => {})
  await answerPrompt('enable')
  expect(invoke).toHaveBeenCalledWith('hosts:settingsAccess', MOCK_HOST_ID)
  act(() => reconnecting())
  expect(document.body.textContent).toContain('Reconnecting to')
  expect(invoke).not.toHaveBeenCalledWith('hosts:settingsRead', MOCK_HOST_ID, 'providers')
  act(() => host(FULL))
  await act(async () => {})
  expect(invoke).toHaveBeenCalledWith('hosts:settingsRead', MOCK_HOST_ID, 'providers')
  expect(document.body.textContent).toContain('personal@example.com')
})

it('stays closed and grants nothing when access is declined', async () => {
  host(['sessions.read', 'sessions.control'])
  render()
  click('Switch account')
  await act(async () => {})
  await answerPrompt(undefined)
  expect(invoke).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Switch account')
})

it('hides the targets when control is lost while picking, and Cancel still closes', async () => {
  host(FULL)
  render()
  click('Switch account')
  await act(async () => {})
  expect(document.body.textContent).toContain('personal@example.com')
  act(() => host(FULL, false))
  expect(document.body.textContent).not.toContain('personal@example.com')
  expect(document.body.textContent).toContain('Take control of this lane')
  click('Cancel')
  expect(document.body.textContent).toContain('Switch account')
})

it('shows a failed first read as a failure, not an empty list, and retries', async () => {
  host(FULL)
  invoke.mockImplementationOnce(async () => {
    throw new Error('Host settings operation not confirmed.')
  })
  render()
  click('Switch account')
  await act(async () => {})
  expect(document.body.textContent).toContain('Host settings operation not confirmed.')
  expect(document.body.textContent).not.toContain('No other signed-in')
  click('Retry')
  await act(async () => {})
  expect(document.body.textContent).toContain('personal@example.com')
})
