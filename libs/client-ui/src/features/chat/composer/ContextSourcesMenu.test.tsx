// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { McpResolvedServer } from '@shared/mcp'
import { ContextSourcesMenu } from './ContextSourcesMenu'
import { contextFileToggleState } from './contextFileToggle'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from './contextBreakdown'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useSessionsStore } from '@/stores/sessions'
import { NavigationProvider } from '@/navigation/Navigation'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const LANE = {
  off: ['agents' as const],
  files: [
    {
      path: '/r/CLAUDE.md',
      kind: 'claude' as const,
      scope: 'project' as const,
      tokens: 5500,
      included: true,
    },
    {
      path: '/r/AGENTS.md',
      kind: 'agents' as const,
      scope: 'project' as const,
      tokens: 800,
      included: false,
    },
    {
      path: '/custom-pi/AGENTS.md',
      kind: 'agents' as const,
      scope: 'global' as const,
      tokens: 200,
      included: false,
    },
  ],
}

const server = (name: string, config: McpResolvedServer['config']): McpResolvedServer => ({
  name,
  config,
  defined: config,
  scope: 'global',
})

describe('contextFileToggleState', () => {
  it('follows the preference on the home composer', () => {
    expect(contextFileToggleState('claude', false, null, undefined)).toMatchObject({
      checked: false,
      missing: false,
      tokens: null,
    })
    expect(contextFileToggleState('claude', true, null, undefined).title).toMatch(/New lanes send/)
  })

  it('follows what the lane reports over the preference, and names the files', () => {
    const claude = contextFileToggleState('claude', false, LANE, undefined)
    expect(claude.checked).toBe(true)
    expect(claude.tokens).toBe(5500)
    expect(claude.title).toContain('~5.5k tokens')
    expect(claude.title).toContain('/r/CLAUDE.md')
    expect(contextFileToggleState('agents', true, LANE, undefined).checked).toBe(false)
  })

  it('says when the lane has no such file, and lets a pending click win', () => {
    const lane = { off: [], files: [] }
    expect(contextFileToggleState('agents', true, lane, undefined)).toMatchObject({
      missing: true,
      title: 'This lane has no AGENTS.md. The setting still carries to new lanes.',
    })
    expect(contextFileToggleState('claude', true, lane, false).checked).toBe(false)
  })

  it('only describes a lane that cannot be changed from here', () => {
    expect(
      contextFileToggleState('agents', true, { off: [], files: [] }, undefined, false).title,
    ).toBe('This lane has no AGENTS.md.')
    const claude = contextFileToggleState('claude', true, LANE, undefined, false)
    expect(claude.title).toBe('CLAUDE.md · ~5.5k tokens\n/r/CLAUDE.md\n\nSent on every request.')
    expect(contextFileToggleState('agents', true, LANE, undefined, false).title).toMatch(
      /Left out of this lane\.$/,
    )
  })
})

describe('ContextSourcesMenu', () => {
  let container: HTMLDivElement
  let root: Root
  let servers: McpResolvedServer[]
  let failContextFile = false
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'mcp:readConfigs') return { servers, files: [] }
    if (channel === 'mcp:setEnabled') {
      servers = servers.map((s) =>
        s.name === args[2] ? { ...s, config: { ...s.config, enabled: args[3] as boolean } } : s,
      )
    }
    if (channel === 'app:setContextFile' && failContextFile) throw new Error('lane gone')
    return undefined
  })

  beforeEach(() => {
    invoke.mockClear()
    failContextFile = false
    servers = []
    ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { invoke }
    useContextFilesPrefStore.setState({ prefs: { claude: true, agents: true } })
    useExtensionUiStore.setState({ statuses: {} })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const trigger = (): HTMLButtonElement =>
    container.querySelector('[data-testid="context-sources"]')!
  const box = (text: string): HTMLInputElement =>
    [...container.querySelectorAll('label')]
      .find((el) => el.textContent?.includes(text))!
      .querySelector('input')!
  const render = async (sessionId?: string): Promise<void> => {
    await act(async () =>
      root.render(<ContextSourcesMenu workspacePath="/repo" sessionId={sessionId} />),
    )
    await act(async () => trigger().click())
  }

  it('shows only the rules when no connector is configured', async () => {
    await render()
    expect(trigger().textContent).toBe('Rules 2/2')
    expect(container.textContent).not.toContain('Connectors')
    expect(container.textContent).toContain('Paths and scopes appear after a lane starts.')
    expect(container.querySelectorAll('li')).toHaveLength(0)
  })

  it('sets the preference for new lanes from the home composer', async () => {
    await render()
    await act(async () => box('CLAUDE.md').click())
    expect(invoke).toHaveBeenCalledWith('app:setContextFile', 'claude', false, undefined)
    expect(useContextFilesPrefStore.getState().prefs).toEqual({ claude: false, agents: true })
    expect(trigger().textContent).toBe('Rules 1/2')
  })

  it('shows the lane’s own state and cost, and changes that lane', async () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: { [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify({ parts: {}, contextFiles: LANE }) },
      },
    })
    await render('s1')
    expect(box('CLAUDE.md').checked).toBe(true)
    expect(box('CLAUDE.md').closest('label')!.textContent).toContain('~5.5k')
    expect(box('AGENTS.md').checked).toBe(false)
    const sources = container.querySelector('[aria-label="AGENTS.md sources"]')!
    expect([...sources.querySelectorAll('li')].map((el) => el.textContent)).toEqual([
      'ProjectExcluded · ~800/r/AGENTS.md',
      'GlobalExcluded · ~200/custom-pi/AGENTS.md',
    ])
    expect(container.textContent).not.toContain('Project rules')
    expect(container.textContent).toContain('Each checkbox controls all files of that type')
    await act(async () => box('AGENTS.md').click())
    expect(invoke).toHaveBeenCalledWith('app:setContextFile', 'agents', true, 's1')
    expect(box('AGENTS.md').checked).toBe(true)
    expect(sources.textContent).not.toContain('Excluded')
    expect(sources.textContent?.match(/Included/g)).toHaveLength(2)
  })

  it('says why a worktree lane leaves out the main checkout’s file while its checkbox stays on', async () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify({
            parts: {},
            contextFiles: {
              off: [],
              files: [
                {
                  path: '/main/CLAUDE.md',
                  kind: 'claude',
                  scope: 'project',
                  tokens: 2600,
                  included: false,
                  excludedBy: 'main-checkout',
                },
                {
                  path: '/main/.phosphor/worktrees/lane/CLAUDE.md',
                  kind: 'claude',
                  scope: 'project',
                  tokens: 2600,
                  included: true,
                },
              ],
            },
          }),
        },
      },
    })
    await render('s1')
    expect(box('CLAUDE.md').checked).toBe(true)
    const sources = container.querySelector('[aria-label="CLAUDE.md sources"]')!
    expect([...sources.querySelectorAll('li')].map((el) => el.textContent)).toEqual([
      'ProjectExcluded · main checkout · ~2.6k/main/CLAUDE.md',
      'ProjectIncluded · ~2.6k/main/.phosphor/worktrees/lane/CLAUDE.md',
    ])
  })

  it('does not guess a scope for an older extension or invent missing files', async () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify({
            parts: {},
            contextFiles: {
              off: [],
              files: [{ path: '/custom/AGENTS.md', kind: 'agents', tokens: 10, included: true }],
            },
          }),
        },
      },
    })
    await render('s1')
    expect(container.textContent).toContain('Scope unknown')
    expect(container.textContent).toContain('/custom/AGENTS.md')
    expect(container.querySelector('[aria-label="CLAUDE.md sources"]')).toBeNull()
    expect(box('CLAUDE.md').closest('label')!.textContent).toContain('none')
  })

  it('puts the box back and says so when the change fails', async () => {
    failContextFile = true
    const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
    await render('s1')
    expect(container.textContent).toContain('File details not yet reported by this lane.')
    await act(async () => box('CLAUDE.md').click())
    expect(box('CLAUDE.md').checked).toBe(true)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('lane gone'), 'error')
  })

  it('turns a server off for new lanes and flags one with direct tools', async () => {
    servers = [
      server('linear', { url: 'https://mcp.linear.app/mcp' }),
      server('knowledge', { url: 'https://k.local/mcp', exposure: 'direct' }),
    ]
    await render()
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 2/2')
    expect(box('knowledge').closest('label')!.textContent).toContain('direct')
    await act(async () => box('knowledge').click())
    expect(invoke).toHaveBeenCalledWith('mcp:setEnabled', 'global', '/repo', 'knowledge', false)
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 1/2')
  })

  it('reads the lane’s own folder and says a change applies from the next message', async () => {
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp' })]
    useSessionsStore.setState({
      live: { s1: { workspacePath: '/repo/.phosphor/worktrees/lane' } } as never,
    })
    await render('s1')
    expect(container.textContent).toContain('from your next message')
    expect(invoke).toHaveBeenCalledWith('mcp:readConfigs', '/repo/.phosphor/worktrees/lane')
    await act(async () => box('linear').click())
    expect(invoke).toHaveBeenCalledWith(
      'mcp:setEnabled',
      'global',
      '/repo/.phosphor/worktrees/lane',
      'linear',
      false,
    )
    useSessionsStore.setState({ live: {} })
  })

  it('says which servers the lane has connected, from its context breakdown', async () => {
    servers = [
      server('linear', { url: 'https://mcp.linear.app/mcp' }),
      server('slack', { url: 'https://mcp.slack.com/mcp' }),
    ]
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify({
            parts: {},
            mcpByServer: { linear: { tokens: 0, count: 0, toolCount: 40 } },
          }),
        },
      },
    })
    await render('s1')
    expect(box('linear').closest('label')!.textContent).toContain('40 tools')
    expect(box('slack').closest('label')!.textContent).not.toContain('tools')
  })

  it('opens Settings › Connectors on the lane’s machine, or the default machine without a lane', async () => {
    const navigate = vi.fn()
    const manage = async (sessionId?: string): Promise<void> => {
      await act(async () =>
        root.render(
          <NavigationProvider value={{ location: { to: 'chat' } as never, navigate }}>
            <ContextSourcesMenu workspacePath="/repo" sessionId={sessionId} />
          </NavigationProvider>,
        ),
      )
      await act(async () => trigger().click())
      const link = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Manage connectors…',
      )!
      await act(async () => link.click())
    }
    await manage()
    expect(navigate).toHaveBeenLastCalledWith({ to: 'page', page: 'settings' })
    useSessionsStore.setState({
      live: { s1: { workspacePath: '/repo', target: { kind: 'local' } } } as never,
    })
    await manage('s1')
    expect(navigate).toHaveBeenLastCalledWith({ to: 'page', page: 'settings', machine: 'local' })
    expect(useSettingsUiStore.getState().tab).toBe('connectors')
    useSessionsStore.setState({ live: {} })
  })

  const hostLane = (breakdown?: object): void => {
    useSessionsStore.setState({
      live: {
        h1: { workspacePath: 'host:bee1/lane', target: { kind: 'remote', hostId: 'bee1' } },
      } as never,
    })
    useExtensionUiStore.setState({
      statuses: breakdown
        ? { h1: { [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify(breakdown) } }
        : {},
    })
  }

  it('shows a Host lane’s rules and connected servers from its breakdown, with no toggle', async () => {
    hostLane({
      parts: {},
      contextFiles: LANE,
      mcpByServer: {
        linear: { tokens: 0, count: 0, toolCount: 40 },
        slack: { tokens: 0, count: 0, toolCount: 1 },
      },
    })
    useContextFilesPrefStore.setState({ prefs: { claude: false, agents: false } })
    await render('h1')
    expect(trigger().textContent).toBe('Rules 1/2 · MCP 2')
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(container.textContent).toContain('this lane')
    expect(container.textContent).toContain('connected in this lane')
    expect(container.textContent).not.toContain('Each checkbox')
    const marks = [...container.querySelectorAll('[role="img"]')].map((el) =>
      el.getAttribute('aria-label'),
    )
    expect(marks).toEqual(['On', 'Off'])
    expect(container.textContent).toContain('40 tools')
    expect(container.textContent).toContain('1 tool')
    expect(invoke).not.toHaveBeenCalledWith('mcp:readConfigs', expect.anything())
    const navigate = vi.fn()
    await act(async () =>
      root.render(
        <NavigationProvider value={{ location: { to: 'chat' } as never, navigate }}>
          <ContextSourcesMenu workspacePath="/repo" sessionId="h1" />
        </NavigationProvider>,
      ),
    )
    await act(async () => trigger().click())
    const link = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Manage connectors…',
    )!
    await act(async () => link.click())
    expect(navigate).toHaveBeenLastCalledWith({ to: 'page', page: 'settings', machine: 'bee1' })
    useSessionsStore.setState({ live: {} })
    useContextFilesPrefStore.setState({ prefs: { claude: true, agents: true } })
  })

  it.each([
    ['no breakdown', undefined],
    ['an older breakdown', { parts: {} }],
  ])('invents nothing for a Host lane with %s', async (_name, breakdown) => {
    hostLane(breakdown)
    await render('h1')
    expect(trigger().textContent).toBe('Rules')
    expect(container.textContent).toContain('Not yet reported by this lane.')
    expect(container.querySelectorAll('input, [role="img"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Connectors')
    expect(invoke).not.toHaveBeenCalled()
    useSessionsStore.setState({ live: {} })
  })

  it('re-reads the servers when Settings closes, since it edits the same files', async () => {
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp' })]
    await render()
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 1/1')
    await act(async () => useSettingsUiStore.getState().setOpen(true))
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp', enabled: false })]
    await act(async () => useSettingsUiStore.getState().setOpen(false))
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 0/1')
  })
})
