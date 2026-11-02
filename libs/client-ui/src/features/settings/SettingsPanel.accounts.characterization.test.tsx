// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeAccountsResult,
  ClaudeLoginState,
  LoginFlowState,
  SubscriptionProviderStatus,
} from '@shared/models'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { SETTINGS_SECTIONS } from './sections/registry'

/*
 * Accounts and the Claude Code page, through the Settings surface on This Mac
 * and on a Host: which controls each machine offers and what each one sends.
 */

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/terminal/TerminalView', () => ({
  TerminalView: ({ ptyId }: { ptyId: string }) => <p>terminal {ptyId}</p>,
}))
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => undefined) }))

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }

const provider = (
  patch: Partial<SubscriptionProviderStatus> & Pick<SubscriptionProviderStatus, 'id' | 'name'>,
): SubscriptionProviderStatus => ({
  requires: 'a plan',
  billing: 'subscription',
  status: 'not_ready',
  ...patch,
})

const PROVIDERS: SubscriptionProviderStatus[] = [
  provider({
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    requires: 'ChatGPT Plus or Pro',
    status: 'ready',
    account: 'me@example.com',
  }),
  provider({ id: 'anthropic', name: 'Claude Pro/Max', caveat: 'Use the Claude Code provider.' }),
  provider({ id: 'xai', name: 'xAI', requires: 'an xAI account', billing: 'balance' }),
]

const ACCOUNTS: ClaudeAccountsResult = {
  prefs: {
    accounts: [
      { id: 'a', label: 'alpha@example.com', credentialDir: null, addedAt: 1 },
      { id: 'b', label: 'beta@example.com', credentialDir: '/b', addedAt: 2 },
    ],
    mode: 'ordered',
    cursor: 0,
    cooldowns: {},
    bindings: {},
  },
  views: ['a', 'b'].map((id) => ({
    account: {
      id,
      label: `${id === 'a' ? 'alpha' : 'beta'}@example.com`,
      credentialDir: null,
      addedAt: 1,
    },
    auth: { ok: true, loggedIn: true, email: `${id === 'a' ? 'alpha' : 'beta'}@example.com` },
    usage: null,
    cooldownUntil: null,
  })),
}

let piLogin: ((state: LoginFlowState) => void) | null = null
let claudeLogin: ((state: ClaudeLoginState) => void) | null = null
let accounts: ClaudeAccountsResult = ACCOUNTS

const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
  switch (channel) {
    case 'packages:list':
      return [
        {
          spec: 'npm:@saccolabs/pi-claude-cli',
          name: '@saccolabs/pi-claude-cli',
          version: '0.10.0',
          installed: true,
          scope: 'global',
          kind: 'npm',
          filtered: false,
          resources: { extensions: [], skills: [], prompts: [], themes: [] },
        },
      ]
    case 'packages:claudeStatus':
      return {
        binary: { found: true, path: '/usr/local/bin/claude', version: '2.1.270' },
        auth: { ok: true, loggedIn: true },
      }
    case 'packages:checkUpdates':
    case 'claude:accountSessions':
      return {}
    case 'packages:claudeCliLatest':
      return null
    case 'claude:accounts':
    case 'claude:refreshAccountUsage':
      return accounts
    case 'claude:usageSnapshot':
      return {
        ok: true,
        snapshot: {
          stale: false,
          contributing: null,
          windows: [{ kind: 'five_hour', label: 'Current session', percentUsed: 40 }],
        },
      }
    case 'pi:subscriptionAuth':
      return PROVIDERS
    case 'pi:loginTerminal':
      return { ptyId: 'pty-login' }
    case 'hosts:settingsRead':
      return mockSettingsRead(args[0] as string, args[1] as never, args[2] as string | undefined)
    case 'hosts:settingsPatch':
      return mockSettingsPatch(args[0] as string, args[1] as never)
    case 'hosts:providerLogin':
      return { ptyId: 'pty-host' }
    default:
      return undefined
  }
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockClear()
  accounts = structuredClone(ACCOUNTS)
  piLogin = null
  claudeLogin = null
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useSessionsStore.setState({ live: {} })
  prepareHostSettings(HOST)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onAccountChanged: () => () => {},
    onPiLoginState: (listener: (state: LoginFlowState) => void) => {
      piLogin = listener
      return () => {}
    },
    onClaudeLoginState: (listener: (state: ClaudeLoginState) => void) => {
      claudeLogin = listener
      return () => {}
    },
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
    onPtyExit: () => () => {},
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const calls = (channel: string): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === channel).map(([, ...args]) => args)
const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  )
const button = (name: string, index = 0): HTMLButtonElement => {
  const found = buttons(name)[index]
  if (!found) throw new Error(`Missing button ${name}`)
  return found
}
const radio = (name: string): HTMLInputElement => {
  const found = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (input) =>
      input.getAttribute('aria-label') === name ||
      input.closest('label')?.textContent?.includes(name),
  )
  if (!found) throw new Error(`Missing radio ${name}`)
  return found
}
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click())
}
const text = (): string => document.body.textContent ?? ''
async function settle(until: () => void): Promise<void> {
  await vi.waitFor(until)
  await act(async () => {})
}

describe('This Mac › Accounts', () => {
  const open = async (): Promise<void> => {
    await showHostSettings(root, 'local', 'accounts')
    await settle(() => expect(text()).toContain('ChatGPT (Codex)'))
  }

  it('groups pi providers by billing, with what each needs and whose account it is', async () => {
    await open()
    expect(text()).toContain('Use a plan you already pay for')
    expect(text()).toContain('Billed per token')
    expect(text()).toContain('Requires ChatGPT Plus or Pro.')
    expect(text()).toContain('Use the Claude Code provider.')
    expect(text()).toContain('me@example.com')
    expect(text()).toContain('Signed in')
    expect(buttons('Sign in again')).toHaveLength(1)
    expect(buttons('Sign in')).toHaveLength(2)
  })

  it('signs in one provider at a time in the app, shows the device code and can cancel', async () => {
    await open()
    await click(button('Sign in'))
    expect(calls('pi:startLogin')).toEqual([['anthropic']])
    expect(button('Sign in').disabled).toBe(true)
    await act(async () =>
      piLogin!({
        providerId: 'anthropic',
        phase: 'awaiting-browser',
        url: 'https://example.com/device',
        userCode: 'WXYZ-1234',
      }),
    )
    expect(text()).toContain('WXYZ-1234')
    expect(buttons('Copy')).toHaveLength(1)
    await click(button('Cancel'))
    expect(calls('pi:cancelLogin')).toEqual([['anthropic']])
  })

  it("re-reads on Refresh and opens pi's own login terminal", async () => {
    await open()
    await click(button('Refresh'))
    expect(calls('pi:subscriptionAuth')).toHaveLength(2)
    await click(button('Open pi’s login terminal'))
    expect(calls('pi:loginTerminal')).toEqual([[80, 20]])
    expect(text()).toContain('terminal pty-login')
  })
})

describe('This Mac › Claude Code', () => {
  const open = async (): Promise<void> => {
    await showHostSettings(root, 'local', 'claude-provider')
    await settle(() => expect(text()).toContain('alpha@example.com'))
  }

  it('reads the provider health and signs accounts in with a pasted code', async () => {
    await open()
    expect(text()).toContain('v2.1.270 at /usr/local/bin/claude')
    await click(button('Add account'))
    expect(calls('claude:startLogin')).toEqual([[undefined]])
    await act(async () => claudeLogin!({ phase: 'awaiting-code', url: 'https://claude.ai/x' }))
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Paste code"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'c0de')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Continue'))
    expect(calls('claude:submitCode')).toEqual([['c0de']])
    await act(async () => claudeLogin!({ phase: 'signed-in' }))
    await click(button('Sign in again', 1))
    expect(calls('claude:startLogin').at(-1)).toEqual(['b'])
  })

  it('reorders by id, refreshes usage and routes new sessions with radios', async () => {
    await open()
    await click(button('Move alpha@example.com down'))
    expect(calls('claude:reorderAccounts')).toEqual([[['b', 'a']]])
    await click(button('Refresh usage'))
    expect(calls('claude:refreshAccountUsage')).toHaveLength(1)
    await click(radio('Round robin'))
    expect(calls('claude:setRouting').at(-1)).toEqual(['round-robin', 'a'])
    accounts.prefs.mode = 'specific'
    await click(radio('One account'))
    await settle(() => expect(radio('Use beta@example.com for new sessions')).toBeTruthy())
    await click(radio('Use beta@example.com for new sessions'))
    expect(calls('claude:setRouting').at(-1)).toEqual(['specific', 'b'])
  })

  it('opens an account for its own usage, and proves the provider end to end', async () => {
    await open()
    const disclosure = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    await click(disclosure.find((b) => b.textContent?.includes('alpha@example.com'))!)
    await settle(() => expect(text()).toContain('40% used'))
    expect(calls('claude:usageSnapshot')).toEqual([['a']])
    expect(text()).toContain('Sessions on this account')
    await click(button('Test provider'))
    expect(calls('packages:testClaudeProvider')).toHaveLength(1)
  })
})

describe('A Host › Accounts and Claude Code', () => {
  /** The Host page that holds Claude Code: its own page once it has one. */
  const claudeTab = (): 'claude-provider' | 'accounts' =>
    SETTINGS_SECTIONS['claude-provider'].Host ? 'claude-provider' : 'accounts'

  it('signs a pi provider in through a private terminal on the Host', async () => {
    await showHostSettings(root, HOST.id, 'accounts')
    await settle(() =>
      expect(document.querySelector('[data-provider="openai-codex"]')).not.toBeNull(),
    )
    const row = document.querySelector('[data-provider="openai-codex"]')!
    const signIn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Sign in')!
    await click(signIn)
    expect(calls('hosts:providerLogin')).toEqual([[HOST.id, 'openai-codex', { configure: true }]])
    expect(document.querySelector('[aria-label="Provider sign-in on bee1"]')).not.toBeNull()
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:'))).toBe(true)
  })

  it('adds and re-authenticates Claude accounts in a private terminal, by Host account id', async () => {
    await showHostSettings(root, HOST.id, claudeTab())
    await settle(() => expect(text()).toContain('work@bee1.example'))
    await click(button('Add account'))
    expect(calls('hosts:providerLogin')).toEqual([
      [HOST.id, 'claude', { addAccount: true, configure: true }],
    ])
    expect(document.querySelector('[aria-label="Provider sign-in on bee1"]')).not.toBeNull()
  })

  it('signs one Host account in again by its id', async () => {
    await showHostSettings(root, HOST.id, claudeTab())
    await settle(() => expect(text()).toContain('work@bee1.example'))
    await click(button('Sign in again', 1))
    expect(calls('hosts:providerLogin')).toEqual([
      [HOST.id, 'claude', { accountId: 'd8736746-ea12-452b-a492-411a74fba4f8', configure: true }],
    ])
  })
})
