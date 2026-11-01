// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import type { BashItem } from '../reducer'
import { BashExecution } from './BashExecution'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const piCommand = vi.fn(async () => ({ success: true }))
let root: Root | null = null
let container: HTMLDivElement | null = null

const bash = (patch: Partial<BashItem>): BashItem => ({
  id: 'b1',
  kind: 'bash',
  command: 'npm test',
  output: '',
  exitCode: null,
  running: false,
  truncated: false,
  ...patch,
})

function render(item: BashItem, sessionId = 'local'): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<BashExecution item={item} sessionId={sessionId} />))
}

const stop = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Stop')

beforeEach(() => {
  ;(window as unknown as { phosphor: unknown }).phosphor = { piCommand }
  piCommand.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('stops a running command with abort_bash', async () => {
  render(bash({ running: true }))
  await act(async () => stop()!.click())
  expect(piCommand).toHaveBeenCalledWith('local', { type: 'abort_bash' })
})

it('keeps Stop on a command a Host could not confirm, and says it is unconfirmed', () => {
  render(bash({ unconfirmed: true, output: 'bee1: may still be running' }))
  expect(stop()).toBeDefined()
  expect(document.body.textContent).toContain('unconfirmed')
  expect(document.body.textContent).not.toContain('exit ?')
})

it('offers no Stop once a command has finished', () => {
  render(bash({ exitCode: 0, output: 'ok' }))
  expect(stop()).toBeUndefined()
})

it('offers no Stop to a Host lane viewer who is not in control', () => {
  const { workspacePath, target, laneId } = mockRemoteInfo
  useSessionsStore.setState({
    live: { remote: { phosphorId: 'remote', workspacePath, target, laneId } },
  })
  const base = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...base,
        lanes: base.lanes.map((lane) => ({
          ...lane,
          control: { fence: 1, controller: { label: 'Laptop', connected: true, self: false } },
        })),
      },
    },
  })
  render(bash({ running: true }), 'remote')
  expect(stop()).toBeUndefined()
})
