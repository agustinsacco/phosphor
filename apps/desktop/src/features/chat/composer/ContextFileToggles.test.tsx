// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextFileToggles } from './ContextFileToggles'
import { contextFileToggleState } from './contextFileToggle'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from './contextBreakdown'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useExtensionUiStore } from '@/stores/extensionUi'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const LANE = {
  off: ['agents' as const],
  files: [
    { path: '/r/CLAUDE.md', kind: 'claude' as const, tokens: 5500, included: true },
    { path: '/r/AGENTS.md', kind: 'agents' as const, tokens: 800, included: false },
  ],
}

describe('contextFileToggleState', () => {
  it('follows the preference on the home composer', () => {
    expect(contextFileToggleState('claude', false, null, undefined)).toMatchObject({
      checked: false,
      missing: false,
    })
    expect(contextFileToggleState('claude', true, null, undefined).title).toMatch(/New lanes send/)
  })

  it('follows what the lane reports over the preference, and names the files', () => {
    const claude = contextFileToggleState('claude', false, LANE, undefined)
    expect(claude.checked).toBe(true)
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

describe('ContextFileToggles', () => {
  let container: HTMLDivElement
  let root: Root
  const invoke = vi.fn(async () => undefined)

  beforeEach(() => {
    invoke.mockClear()
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

  const box = (label: string): HTMLInputElement =>
    [...container.querySelectorAll('label')]
      .find((el) => el.textContent === label)!
      .querySelector('input')!

  it('sets the preference for new lanes from the home composer', async () => {
    act(() => root.render(<ContextFileToggles />))
    await act(async () => box('CLAUDE.md').click())
    expect(invoke).toHaveBeenCalledWith('app:setContextFile', 'claude', false, undefined)
    expect(useContextFilesPrefStore.getState().prefs).toEqual({ claude: false, agents: true })
  })

  it('shows the lane’s own state and changes that lane', async () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: { [CONTEXT_BREAKDOWN_STATUS_KEY]: JSON.stringify({ parts: {}, contextFiles: LANE }) },
      },
    })
    act(() => root.render(<ContextFileToggles sessionId="s1" />))
    expect(box('CLAUDE.md').checked).toBe(true)
    expect(box('AGENTS.md').checked).toBe(false)
    await act(async () => box('AGENTS.md').click())
    expect(invoke).toHaveBeenCalledWith('app:setContextFile', 'agents', true, 's1')
    expect(box('AGENTS.md').checked).toBe(true)
  })

  it('puts the box back and says so when the change fails', async () => {
    invoke.mockRejectedValueOnce(new Error('lane gone'))
    const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
    act(() => root.render(<ContextFileToggles sessionId="s1" />))
    await act(async () => box('CLAUDE.md').click())
    expect(box('CLAUDE.md').checked).toBe(true)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('lane gone'), 'error')
  })
})
