// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSettingsUiStore } from '../settingsUiStore'
import { HostSectionProvider, useHostSection, type MachineSettingsTab } from './HostSection'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => 'run') }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'hosts:machineTask') throw new Error('The task failed on bee1')
  return undefined
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin' })
  vi.mocked(promptChoice).mockResolvedValue('run')
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
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

function Probe(): React.JSX.Element {
  const { programs, error } = useHostSection()
  return (
    <>
      <button onClick={() => programs.task({ task: 'mcp.login', name: 'docs' })}>Run</button>
      <p data-testid="error">{error}</p>
    </>
  )
}
const show = (section: MachineSettingsTab) =>
  act(async () =>
    root.render(
      <HostSectionProvider machine={machine} section={section} scoped>
        <Probe />
      </HostSectionProvider>,
    ),
  )
const error = () => container.querySelector('[data-testid=error]')!.textContent
async function failTask(): Promise<void> {
  await act(async () => container.querySelector('button')!.click())
  expect(error()).toBe('The task failed on bee1')
}

it('drops a program error when another section opens (regression R-U9)', async () => {
  await show('connectors')
  await failTask()
  await show('providers')
  expect(error()).toBe('')
})

it('drops a program error when another folder is chosen (regression R-U9)', async () => {
  await show('connectors')
  await failTask()
  await act(async () => useSettingsUiStore.getState().setFolder('0000000000000001'))
  expect(error()).toBe('')
})
