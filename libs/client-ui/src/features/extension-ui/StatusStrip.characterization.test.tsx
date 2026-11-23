// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
vi.hoisted(() => {
  // The settings store, imported along the way, follows the system theme.
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
})

import type { RpcSlashCommand } from '@shared/rpc'
import type { ToolState } from '@/features/chat/chatItems'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLayoutStore } from '@/stores/layout'
import { StatusStrip } from './StatusStrip'

const STRUCTURED = {
  'phosphor-context-breakdown': '{"total":1}',
  'claude-rate-limit': '{"limit":1}',
  'phosphor-headroom': '{"ok":true}',
  'phosphor-reload': '{"token":"t"}',
  'mcp-inspection': '{"id":"x"}',
  'phosphor-swarm': '{"on":true}',
}

const fleetLine = (runs: unknown[]): string =>
  `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
    kind: 'pi-subagents.async-status-snapshot',
    version: 1,
    generatedAt: 1,
    runs,
  })}`

let root: Root
let el: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  useExtensionUiStore.setState({ statuses: {}, widgets: {} })
  useChatStore.setState({ sessions: {} })
  useLayoutStore.setState({ bySession: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function render(sessionId = 's1'): void {
  act(() => root.render(<StatusStrip sessionId={sessionId} />))
}
function session(commands: RpcSlashCommand[], tools: Record<string, ToolState> = {}): void {
  useChatStore.getState().ensure('s1')
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, s1: { ...s.sessions.s1!, commands, tools } },
  }))
}
const chip = (): HTMLButtonElement | null => el.querySelector('[data-testid="subagent-chip"]')
const entryTexts = (): string[] =>
  [...el.querySelectorAll('span[data-tooltip]')].map((node) => node.textContent ?? '')

describe('StatusStrip characterization', () => {
  it('renders nothing without statuses, a fleet widget or subagent support', () => {
    render()
    expect(el.innerHTML).toBe('')
  })

  it('renders nothing when every status is a structured machine payload', () => {
    useExtensionUiStore.setState({ statuses: { s1: { ...STRUCTURED } } })
    render()
    expect(el.innerHTML).toBe('')
  })

  it('prints unknown keys as text in insertion order, hiding structured keys', () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          zeta: 'last-inserted-first',
          'phosphor-swarm': '{"on":true}',
          alpha: '\u001b[31mred\u001b[0m plain',
          'phosphor-context-breakdown': '{"total":1}',
        },
      },
    })
    render()
    expect(chip()).toBeNull()
    expect(entryTexts()).toEqual(['last-inserted-first', 'red plain'])
    const tips = [...el.querySelectorAll('span[data-tooltip]')].map((n) =>
      n.getAttribute('data-tooltip'),
    )
    expect(tips).toEqual(['last-inserted-first', 'red plain'])
    const colored = [...el.querySelectorAll('span[style]')]
    expect(colored.map((n) => n.textContent)).toEqual(['red'])
    expect(el.textContent).not.toContain('\u001b')
    expect(el.textContent).not.toContain('"on"')
    expect(el.textContent).not.toContain('total')
  })

  it('shows a plain Subagents chip first when the session has the subagent command', () => {
    session([{ name: 'subagents', source: 'extension' } as RpcSlashCommand])
    useExtensionUiStore.setState({ statuses: { s1: { other: 'busy' } } })
    render()
    const strip = el.firstElementChild!
    expect(strip.firstElementChild).toBe(chip())
    expect(chip()!.textContent).toBe('Subagents')
    expect(chip()!.disabled).toBe(false)
    expect(chip()!.getAttribute('aria-label')).toBe('Open subagents')
    expect(chip()!.getAttribute('data-tooltip')).toBe('Recorded delegation and child inspection')
    expect(entryTexts()).toEqual(['busy'])
    act(() => chip()!.click())
    expect(useLayoutStore.getState().bySession.s1).toMatchObject({
      pane: 'subagents',
      side: 'right',
    })
  })

  it('treats the inspect command or a subagent tool call as support, but not a skill', () => {
    session([{ name: 'subagents-inspect-rpc', source: 'extension' } as RpcSlashCommand])
    render()
    expect(chip()!.textContent).toBe('Subagents')
    session([{ name: 'subagents', source: 'skill' } as RpcSlashCommand])
    render()
    expect(chip()).toBeNull()
    session([], { t1: { toolCallId: 't1', toolName: 'subagent' } as ToolState })
    render()
    expect(chip()!.textContent).toBe('Subagents')
  })

  it('summarizes the legacy claude-subagents status and disables it without support', () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          'claude-subagents': JSON.stringify({
            tasks: [
              { taskId: 'a', description: 'scan', status: 'completed' },
              { taskId: 'b', description: '', status: 'running', currentStep: 'Reading x' },
            ],
          }),
        },
      },
    })
    render()
    expect(chip()!.textContent).toBe('1 agent running · Reading x')
    expect(chip()!.disabled).toBe(true)
    expect(chip()!.getAttribute('data-tooltip')).toBe('scan: completed\nb: running')
    expect(chip()!.querySelector('.bg-accent')).not.toBeNull()
    expect(entryTexts()).toEqual([])
  })

  it('keeps an empty strip when the legacy status is unreadable and nothing else shows', () => {
    useExtensionUiStore.setState({ statuses: { s1: { 'claude-subagents': 'not json' } } })
    render()
    expect(chip()).toBeNull()
    expect(el.children).toHaveLength(1)
    expect(el.firstElementChild!.children).toHaveLength(0)
  })

  it('prefers the fleet widget over the legacy status and stays enabled', () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          'claude-subagents': JSON.stringify({ tasks: [{ taskId: 'a', status: 'running' }] }),
        },
      },
      widgets: {
        s1: {
          'subagent-async': {
            placement: 'aboveEditor',
            lines: [
              fleetLine([
                { id: 'r1', label: 'old', state: 'complete' },
                {
                  id: 'r2',
                  label: 'scout',
                  state: 'running',
                  activity: { currentTool: 'grep' },
                },
              ]),
            ],
          },
        },
      },
    })
    render()
    expect(chip()!.textContent).toBe('1 background run active · scout · grep')
    expect(chip()!.disabled).toBe(false)
    expect(chip()!.getAttribute('data-tooltip')).toBe('old: complete\nscout: running')
    expect(chip()!.querySelector('.bg-accent')).not.toBeNull()
  })

  it('shows an idle fleet chip from the widget alone', () => {
    useExtensionUiStore.setState({
      widgets: {
        s1: {
          'subagent-async': {
            placement: 'aboveEditor',
            lines: [fleetLine([{ id: 'r1', label: 'done', state: 'complete' }])],
          },
        },
      },
    })
    render()
    expect(chip()!.textContent).toBe('No background runs active')
    expect(chip()!.querySelector('.bg-accent')).toBeNull()
    expect(chip()!.querySelector('.bg-text-tertiary\\/50')).not.toBeNull()
  })
})
