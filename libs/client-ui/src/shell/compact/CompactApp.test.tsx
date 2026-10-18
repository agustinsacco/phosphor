// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MACHINE } from '@/features/machines/__fixtures__/control'
import type { MachineView } from '@shared/control-api'
import { newRoutine, type Routine } from '@shared/routines'
import { useRoutinesStore } from '@/stores/routines'
import { renameSession } from '@/features/sessions/sessionActions'
import { promptChoice, usePromptStore } from '@/stores/prompt'
import type { AccountView } from '@shared/account'
import type * as Screens from '@/navigation/screens'
import { CompactApp } from './CompactApp'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useDraftsStore } from '@/stores/drafts'

vi.mock('@/navigation/screens', async (importOriginal) => {
  const original = await importOriginal<typeof Screens>()
  const { RoutinesPage } = await import('@/features/routines/RoutinesPage')
  return {
    ...original,
    GlobalScreen: ({ page, workspacePath }: { page: string; workspacePath: string }) =>
      page === 'routines' ? (
        <RoutinesPage workspacePath={workspacePath} />
      ) : (
        <p>Resource surface</p>
      ),
  }
})
vi.mock('./CompactLane', () => ({ CompactLane: () => <p>Lane surface</p> }))
vi.mock('./CompactNew', () => ({ CompactNew: () => <p>New lane surface</p> }))
vi.mock('./CompactSettings', () => ({ CompactSettings: () => <p>Settings surface</p> }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({
  ExtensionDialogHost: () => null,
  ToastHost: () => null,
}))
vi.mock('@/lib/fonts', () => ({ loadBundledFonts: async () => undefined }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ hydrate: async () => undefined }) },
}))
let root: Root
let container: HTMLDivElement
let account: AccountView
let directory: MachineView[]
const routine: Routine = {
  ...newRoutine(''),
  id: `host:${MACHINE.id}/fixture-routine`,
  name: 'Fixture routine',
  enabled: true,
  instructions: 'fixture',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  nextAt: null,
  attention: null,
  archived: false,
  machine: {
    id: `host:${MACHINE.id}`,
    label: 'Fixture Host',
    repositoryId: 'fixture-repo',
    control: true,
  },
}
let accountListeners: Set<(view: AccountView) => void>
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'account:get') return account
  if (channel === 'control:machines')
    return { ok: true, machines: directory, serverTime: new Date().toISOString() }
  if (channel === 'hosts:snapshot')
    return Object.fromEntries(
      directory.map((machine) => [
        machine.id,
        {
          state: 'ready',
          connectionToken: 'fixture',
          capabilities: ['routines', 'sessions.read'],
          repositories: [],
          lanes: [],
        },
      ]),
    )
  if (channel === 'routines:list')
    return { routines: [routine], runs: [], error: null, background: false, machines: [] }
  if (channel === 'routines:history') return []
  if (channel === 'routines:save') return routine
  if (channel === 'account:signOut') return account
  if (channel === 'hosts:setFocusedLane' || channel === 'account:signIn') return undefined
  throw new Error(`Unexpected IPC ${channel}`)
})
beforeEach(() => {
  account = { account: { status: 'signed-out' } }
  directory = []
  useRoutinesStore.setState({ snapshot: null, machines: [], remote: {}, error: null })
  accountListeners = new Set()
  invoke.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'linux',
    onAccountChanged: (listener: (view: AccountView) => void) => {
      accountListeners.add(listener)
      return () => accountListeners.delete(listener)
    },
    onMachinesChanged: () => () => {},
    onHostsChanged: () => () => {},
    onHostAttention: () => () => {},
    onHostOpenLane: () => () => {},
    onPiCommandsChanged: () => () => {},
    onRoutinesChanged: () => () => {},
    piCommand: vi.fn(async () => ({ success: true })),
  })
  window.history.replaceState(null, '', '/lanes')
  useMachinesStore.setState({ machines: [], remoteEnabled: false })
  useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const request of usePromptStore.getState().requests)
    usePromptStore.getState().dismiss(request, undefined)
  vi.unstubAllGlobals()
})
it('renders sign-in for pending/unauthenticated identity without native startup', async () => {
  await act(async () => root.render(<CompactApp />))
  const signIn = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Sign in with GitHub',
  )
  expect(signIn).toBeDefined()
  await act(async () => signIn?.click())
  expect(invoke).toHaveBeenCalledWith('account:signIn')
  expect(
    invoke.mock.calls.every(
      ([channel]) => !channel.startsWith('pi:') && !channel.startsWith('fs:'),
    ),
  ).toBe(true)
})
it('boots only remote subscriptions, follows history, and returns to sign-in on account loss', async () => {
  account = {
    account: {
      status: 'signed-in',
      user: { login: 'fixture', name: null, email: null },
      remembered: false,
    },
  }
  await act(async () => root.render(<CompactApp />))
  expect(container.querySelector('[data-testid="compact-shell"]')).not.toBeNull()
  expect(container.textContent).toContain('No machines yet')
  expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('pi:health')
  expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('app:resumeTarget')
  await act(async () => {
    window.history.replaceState(null, '', '/invalid')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(container.textContent).toContain('This link is unavailable')
  await act(async () => {
    account = { account: { status: 'signed-out' } }
    for (const listener of [...accountListeners]) listener(account)
  })
  expect(container.textContent).toContain('Sign in with GitHub')
  expect(useRemoteLanesStore.getState().hosts).toEqual({})
})

function signedIn(login: string | null = 'fixture'): AccountView {
  return {
    account: { status: 'signed-in', user: { login, name: null, email: null }, remembered: false },
  }
}
async function publishAccount(view: AccountView): Promise<void> {
  await act(async () => {
    account = view
    for (const listener of [...accountListeners]) listener(view)
  })
}
it('executes a real routine Pause action through the compact context-menu host', async () => {
  account = signedIn()
  directory = [MACHINE]
  window.history.replaceState(null, '', `/pages/routines/${MACHINE.id}`)
  await act(async () => root.render(<CompactApp />))
  const row = container.querySelector<HTMLButtonElement>('[data-testid="routine-row"]')
  expect(row).not.toBeNull()
  await act(async () => row?.click())
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')
  expect(more).not.toBeNull()
  await act(async () => more?.click())
  const pause = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] button'),
  ].find((button) => button.textContent?.startsWith('Pause'))
  expect(pause).toBeDefined()
  await act(async () => pause?.click())
  expect(invoke).toHaveBeenCalledWith(
    'routines:save',
    expect.objectContaining({ id: routine.id, enabled: false }),
    routine.id,
    routine.revision,
  )
})
it('renders a removed scoped Host as unavailable instead of remaining Opening or mounting a local page', async () => {
  account = signedIn()
  directory = [MACHINE]
  window.history.replaceState(null, '', `/pages/skills/${MACHINE.id}`)
  await act(async () => root.render(<CompactApp />))
  expect(container.textContent).toContain('Resource surface')
  await act(async () => useMachinesStore.setState({ machines: [], loading: false }))
  expect(useRemoteLanesStore.getState().filter).toBe('local')
  expect(container.textContent).toContain('This machine is no longer in your account.')
  expect(container.textContent).not.toContain('Opening…')
  expect(container.textContent).not.toContain('Resource surface')
  expect(invoke.mock.calls.some(([channel]) => channel.startsWith('pi:'))).toBe(false)
})
it('cancels and settles all pending prompts before a replacement owner can act on them', async () => {
  account = signedIn()
  await act(async () => root.render(<CompactApp />))
  let rename!: Promise<string | undefined>
  let choice!: Promise<string | undefined>
  await act(async () => {
    rename = renameSession('retired-session', 'retired name')
    choice = promptChoice({ title: 'Retired choice', choices: [{ value: 'yes', label: 'Yes' }] })
  })
  const retired = usePromptStore.getState().requests[0]!
  expect(usePromptStore.getState().requests).toHaveLength(2)
  await publishAccount({ account: { status: 'signed-out' } })
  expect(usePromptStore.getState().requests).toEqual([])
  await expect(rename).resolves.toBeUndefined()
  await expect(choice).resolves.toBeUndefined()
  await publishAccount(signedIn('replacement'))
  expect(document.querySelector('[aria-label="Rename session"]')).toBeNull()
  await act(async () => usePromptStore.getState().dismiss(retired, 'late submission'))
  expect(window.phosphor.piCommand).not.toHaveBeenCalled()
})
it.each(['fixture', null])(
  'clears owner state across batched identical profiles: %s',
  async (login) => {
    account = signedIn(login)
    await act(async () => root.render(<CompactApp />))
    let pending!: Promise<string | undefined>
    await act(async () => {
      pending = renameSession('retired-session', 'retired name')
      useDraftsStore.setState({
        drafts: { retired: { text: 'private old draft', attachments: [] } },
        revisions: { retired: 1 },
      })
    })
    const retired = usePromptStore.getState().requests[0]!
    // A normal same-owner refresh must not discard an unsent draft or prompt.
    await publishAccount(signedIn(login))
    expect(usePromptStore.getState().requests).toHaveLength(1)
    expect(useDraftsStore.getState().get('retired').text).toBe('private old draft')
    await act(async () => {
      // The real adapter emits these synchronously when client/CSRF identity changes.
      for (const view of [{ account: { status: 'signed-out' } } as AccountView, signedIn(login)]) {
        account = view
        for (const listener of [...accountListeners]) listener(view)
      }
    })
    expect(usePromptStore.getState().requests).toEqual([])
    await expect(pending).resolves.toBeUndefined()
    expect(useDraftsStore.getState().drafts).toEqual({})
    expect(container.querySelector('[data-testid="compact-shell"]')).not.toBeNull()
    await act(async () => usePromptStore.getState().dismiss(retired, 'late submission'))
    expect(window.phosphor.piCommand).not.toHaveBeenCalled()
  },
)
it.each([
  'Signed out here. Remote cleanup is pending; existing Host grants may remain valid briefly.',
  'Disconnected here. Cookie sign-out and remote revocation were not confirmed. Retry sign out.',
])('retains adapter-owned warning and Retry sign out across retries: %s', async (warning) => {
  account = { account: { status: 'signed-out', error: warning } }
  await act(async () => root.render(<CompactApp />))
  expect(container.textContent).toContain(warning)
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry sign out',
  )
  expect(retry).toBeDefined()
  await act(async () => retry?.click())
  expect(invoke).toHaveBeenCalledWith('account:signOut')
  expect(container.textContent).toContain(warning)
  await publishAccount({ account: { status: 'signed-out' } })
  expect(container.textContent).not.toContain(warning)
  expect(container.textContent).toContain('Sign in with GitHub')
})
