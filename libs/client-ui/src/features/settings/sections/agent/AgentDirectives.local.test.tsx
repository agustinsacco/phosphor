// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { subagentPolicyBlock } from '@shared/agent-directives'
import { prepareHostSettings, showHostSettings } from '../../__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from '../../settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('../../useAccount', () => ({
  useAccount: () => ({ view: { account: { status: 'signed-in' } }, error: null, generation: 0 }),
}))
vi.mock('../../instructions/EditInstructions', () => ({
  EditInstructions: ({ source }: { source: { key: string; machine: string } }) => (
    <div data-editor={source.key}>{source.machine}</div>
  ),
}))

let root: Root
let container: HTMLDivElement
let retired: Record<string, string>
let byProject: Record<string, typeof DEFAULT_AGENT_DIRECTIVES>
const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
  if (channel === 'app:getPrefs')
    return {
      ...DEFAULT_APP_PREFS,
      retiredDirectives: retired,
      agentDirectivesByProject: byProject,
    }
  if (channel === 'app:clearRetiredDirectives') retired = {}
  if (channel === 'pi:agentSettingsScoped') return { global: {}, project: null }
  if (channel === 'pi:checkAgentSettings')
    return { global: { exists: true, malformed: false }, project: null }
  if (channel === 'mcp:readConfigs') return { projectTrust: null }
  return undefined
})
beforeEach(() => {
  retired = {}
  byProject = {}
  invoke.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'linux', onAccountChanged: () => () => {} })
  prepareHostSettings({ id: 'unused', label: 'unused' })
  useSettingsUiStore.setState({ folder: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === label)!
const preview = () => container.querySelector('pre')!.textContent!
const show = () => showHostSettings(root, 'local', 'agent')
const laneCharter = () =>
  container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lane charter"]')!

describe("This Mac's instructions and directives", () => {
  it('previews what the session service composes, block by block', async () => {
    await show()
    expect(preview()).toContain('<phosphor_workspace>')
    expect(preview()).toContain("You are running on the user's own computer")
    expect(preview()).toContain('<phosphor_lane>')
    expect(preview()).toContain(subagentPolicyBlock())
    expect(container.textContent).not.toContain('Your own text')
    await act(async () => laneCharter().click())
    expect(invoke).toHaveBeenCalledWith(
      'app:setAgentDirectives',
      { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false },
      undefined,
    )
  })

  it("opens this computer's instructions editor", async () => {
    await show()
    await act(async () => button('Edit instructions').click())
    expect(container.querySelector('[data-editor="local"]')!.textContent).toBe('This computer')
  })

  it('keeps retired text visible until it is dismissed', async () => {
    retired = { '/repo': 'Never touch src/gen.' }
    await show()
    const note = container.querySelector('[aria-label="Retired directive text"]')!
    expect(note.textContent).toContain('/repo')
    expect(note.textContent).toContain('Never touch src/gen.')
    await act(async () => button('Dismiss').click())
    expect(invoke).toHaveBeenCalledWith('app:clearRetiredDirectives')
    expect(container.querySelector('[aria-label="Retired directive text"]')).toBeNull()
  })

  it('follows the scope line: a folder writes and clears its own override, with no switch of its own', async () => {
    byProject = { '/repo': { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false } }
    useSettingsUiStore.setState({ folder: '/repo' })
    await show()
    expect(button('GLOBAL')).toBeUndefined()
    expect(laneCharter().getAttribute('aria-checked')).toBe('false')
    await act(async () => laneCharter().click())
    expect(invoke).toHaveBeenCalledWith('app:setAgentDirectives', DEFAULT_AGENT_DIRECTIVES, '/repo')
    await act(async () => button('Clear this folder’s override').click())
    expect(invoke).toHaveBeenCalledWith('app:setAgentDirectives', null, '/repo')
  })
})
