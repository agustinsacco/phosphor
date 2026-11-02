// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { subagentPolicyBlock } from '@shared/agent-directives'
import { DirectivesSection } from './DirectivesSection'

vi.mock('../SettingsMachineScope', () => ({ useSettingsWorkspace: () => '/repo' }))
vi.mock('../useAccount', () => ({
  useAccount: () => ({ view: { account: { status: 'signed-in' } }, error: null, generation: 0 }),
}))
vi.mock('../instructions/EditInstructions', () => ({
  EditInstructions: ({ source }: { source: { key: string; machine: string } }) => (
    <div data-editor={source.key}>{source.machine}</div>
  ),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let retired: Record<string, string>
const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
  if (channel === 'app:getPrefs') return { ...DEFAULT_APP_PREFS, retiredDirectives: retired }
  if (channel === 'app:clearRetiredDirectives') retired = {}
  return undefined
})
beforeEach(() => {
  retired = {}
  invoke.mockClear()
  vi.stubGlobal('phosphor', { invoke, platform: 'linux' })
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

describe('DirectivesSection', () => {
  it('previews what the session service composes, block by block', async () => {
    await act(async () => root.render(<DirectivesSection />))
    expect(preview()).toContain('<phosphor_workspace>')
    expect(preview()).toContain("You are running on the user's own computer")
    expect(preview()).toContain('<phosphor_lane>')
    expect(preview()).toContain(subagentPolicyBlock())
    expect(container.textContent).not.toContain('Your own text')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lane charter"]')!
        .click(),
    )
    expect(invoke).toHaveBeenCalledWith(
      'app:setAgentDirectives',
      { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false },
      undefined,
    )
  })

  it("opens this computer's instructions editor", async () => {
    await act(async () => root.render(<DirectivesSection />))
    await act(async () => button('Edit instructions').click())
    expect(container.querySelector('[data-editor="local"]')!.textContent).toBe('This computer')
  })

  it('keeps retired text visible until it is dismissed', async () => {
    retired = { '/repo': 'Never touch src/gen.' }
    await act(async () => root.render(<DirectivesSection />))
    const note = container.querySelector('[aria-label="Retired directive text"]')!
    expect(note.textContent).toContain('/repo')
    expect(note.textContent).toContain('Never touch src/gen.')
    await act(async () => button('Dismiss').click())
    expect(invoke).toHaveBeenCalledWith('app:clearRetiredDirectives')
    expect(container.querySelector('[aria-label="Retired directive text"]')).toBeNull()
  })
})
