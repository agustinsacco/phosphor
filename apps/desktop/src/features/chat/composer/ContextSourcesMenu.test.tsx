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
  scope: 'pi-global',
  shadows: [],
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
})

describe('ContextSourcesMenu', () => {
  let container: HTMLDivElement
  let root: Root
  let servers: McpResolvedServer[]
  let failContextFile = false
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'mcp:readConfigs') return { servers, files: [] }
    if (channel === 'mcp:setDisabled') {
      servers = servers.map((s) =>
        s.name === args[2] ? { ...s, config: { ...s.config, disabled: args[3] as boolean } } : s,
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

  it('turns a server off for new lanes and flags one that skips the gateway', async () => {
    servers = [
      server('linear', { url: 'https://mcp.linear.app/mcp' }),
      server('knowledge', { url: 'https://k.local/mcp', directTools: true }),
    ]
    await render()
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 2/2')
    expect(box('knowledge').closest('label')!.textContent).toContain('direct')
    await act(async () => box('knowledge').click())
    expect(invoke).toHaveBeenCalledWith('mcp:setDisabled', 'pi-global', '/repo', 'knowledge', true)
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
      'mcp:setDisabled',
      'pi-global',
      '/repo/.phosphor/worktrees/lane',
      'linear',
      true,
    )
    useSessionsStore.setState({ live: {} })
  })

  it('re-reads the servers when Settings closes, since it edits the same files', async () => {
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp' })]
    await render()
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 1/1')
    await act(async () => useSettingsUiStore.getState().setOpen(true))
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp', disabled: true })]
    await act(async () => useSettingsUiStore.getState().setOpen(false))
    expect(trigger().textContent).toBe('Rules 2/2 · MCP 0/1')
  })
})
