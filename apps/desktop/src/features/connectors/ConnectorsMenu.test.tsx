// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { McpResolvedServer } from '@shared/mcp'
import { ConnectorsMenu } from './ConnectorsMenu'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const server = (name: string, config: McpResolvedServer['config']): McpResolvedServer => ({
  name,
  config,
  scope: 'pi-global',
  shadows: [],
})

describe('ConnectorsMenu', () => {
  let container: HTMLDivElement
  let root: Root
  let servers: McpResolvedServer[]
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'mcp:readConfigs') return { servers, files: [] }
    if (channel === 'mcp:setDisabled') {
      servers = servers.map((s) =>
        s.name === args[2] ? { ...s, config: { ...s.config, disabled: args[3] as boolean } } : s,
      )
    }
    return undefined
  })

  beforeEach(() => {
    invoke.mockClear()
    ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { invoke }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('stays out of the way with no servers configured', async () => {
    servers = []
    await act(async () => root.render(<ConnectorsMenu workspacePath="/repo" />))
    expect(container.textContent).toBe('')
  })

  it('turns a server off for new lanes and flags one that skips the gateway', async () => {
    servers = [
      server('linear', { url: 'https://mcp.linear.app/mcp' }),
      server('knowledge', { url: 'https://k.local/mcp', directTools: true }),
    ]
    await act(async () => root.render(<ConnectorsMenu workspacePath="/repo" />))
    const trigger = container.querySelector('button')!
    expect(trigger.textContent).toBe('MCP 2/2')
    await act(async () => trigger.click())
    const row = [...container.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('knowledge'),
    )!
    expect(row.textContent).toContain('direct')
    await act(async () => row.querySelector('input')!.click())
    expect(invoke).toHaveBeenCalledWith('mcp:setDisabled', 'pi-global', '/repo', 'knowledge', true)
    expect(trigger.textContent).toBe('MCP 1/2')
  })

  it('re-reads the servers when Settings closes, since it edits the same files', async () => {
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp' })]
    await act(async () => root.render(<ConnectorsMenu workspacePath="/repo" />))
    expect(container.textContent).toBe('MCP 1/1')
    await act(async () => useSettingsUiStore.getState().setOpen(true))
    servers = [server('linear', { url: 'https://mcp.linear.app/mcp', disabled: true })]
    await act(async () => useSettingsUiStore.getState().setOpen(false))
    expect(container.textContent).toBe('MCP 0/1')
  })
})
