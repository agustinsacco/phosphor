// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { MachineSettings } from './MachineSettings'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead, mockSettingsPatch } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/settings/instructions/EditInstructions', () => ({
  EditInstructions: ({ source }: { source: { key: string; machine: string } }) => (
    <div data-editor={source.key}>{source.machine}</div>
  ),
}))
const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root, container: HTMLDivElement
let legacy = false
beforeEach(() => {
  legacy = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useMachinesStore.setState({ view: { kind: 'machine', id: machine.id, settings: 'agent' } })
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') {
      const read = mockSettingsRead(hostId, section, repositoryId)
      if (legacy) delete read.agent?.agentDirectives
      return read
    }
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'hosts:models') return []
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
async function render() {
  await act(async () => root.render(<MachineSettings machine={machine} section="agent" />))
}

it("saves a Host's directive switches as Host config, merged with what it has", async () => {
  await render()
  expect(container.querySelector('pre')!.textContent).toContain('bee1 (host-os), a Phosphor Host')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lane charter"]')!
      .click(),
  )
  expect(container.querySelector('pre')!.textContent).not.toContain('<phosphor_lane>')
  // Saves on change, like the rest of Agent defaults, with no review step.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(invoke).toHaveBeenCalledWith(
    'hosts:settingsPatch',
    machine.id,
    expect.objectContaining({
      section: 'agent',
      change: {
        type: 'agent.patch',
        patch: { agentDirectives: { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false } },
      },
    }),
  )
  expect(promptChoice).not.toHaveBeenCalled()
})

it("opens the Host's own instructions file, never this computer's", async () => {
  await render()
  await act(async () => button('Edit instructions').click())
  expect(container.querySelector(`[data-editor="host-${machine.id}"]`)!.textContent).toBe('bee1')
  expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('pi:'))).toBe(false)
})

it('asks an older Host to update instead of offering switches it ignores', async () => {
  legacy = true
  await render()
  expect(container.textContent).toContain('Update this Host to edit its global instructions')
  expect(container.querySelector('[aria-label="Lane charter"]')).toBeNull()
})
