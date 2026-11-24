// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useTerminalStore, machineTarget, terminalOwner } from '@/stores/terminal'
import { MachineTerminalTab } from './MachineTerminalTab'

// The machine page and a lane share this pane; the xterm itself is tested with lanes.
vi.mock('@/features/terminal/TerminalView', () => ({
  TerminalView: ({ ptyId }: { ptyId: string }) => <div data-shell={ptyId}>Shell attached</div>,
}))

let root: Root
let el: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
let attempts: number
let kills: string[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  attempts = 0
  kills = []
  fake = createFakePhosphor({
    'hosts:machineShell': () => {
      if (++attempts === 1) throw new Error('temporarily offline')
      return { ptyId: 'remote-pty-shell' }
    },
    'pty:kill': (ptyId: string) => {
      kills.push(ptyId)
      return undefined
    },
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.machineShell = true
  host.capabilities.push('terminal')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useTerminalStore.setState({ byOwner: {}, pendingPaste: null })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  useTerminalStore.setState({ byOwner: {}, pendingPaste: null })
  vi.unstubAllGlobals()
})

const render = async (): Promise<void> => {
  await act(async () => root.render(<MachineTerminalTab hostId={MOCK_HOST_ID} label="bee" />))
  // The shared pane — xterm and all — arrives on demand, then opens its first shell.
  await vi.waitFor(() => expect(el.querySelector('.terminal-surface')).toBeTruthy())
}

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click()
  })
}

const button = (text: string): HTMLElement => {
  const found = [...el.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}

it('opens the machine shell on first view, recovers from a failed open, and ends it on close', async () => {
  await render()
  await vi.waitFor(() => expect(attempts).toBe(1))
  expect(el.textContent).toContain('Could not start a shell')
  expect(el.textContent).toContain('temporarily offline')
  await click(button('Try again'))
  await vi.waitFor(() =>
    expect(el.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('remote-pty-shell'),
  )
  const close = el.querySelector<HTMLButtonElement>('button[aria-label="Close Terminal 1"]')!
  await click(close)
  expect(kills).toEqual(['remote-pty-shell'])
  expect(el.querySelector('[data-shell]')).toBeNull()
})

it('keeps the shell and its tab across a visit to another tab', async () => {
  await render()
  await click(button('Try again'))
  await vi.waitFor(() => expect(el.querySelector('[data-shell]')).not.toBeNull())
  // Leaving the Terminal tab unmounts the pane. The shell and its tab stay in
  // the store, so coming back reattaches instead of starting a second shell.
  await act(async () => root.render(<div />))
  await render()
  expect(attempts).toBe(2)
  expect(el.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('remote-pty-shell')
})

it('says what is in the way and never opens a shell it may not have', async () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.state = 'reconnecting'
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  await render()
  expect(el.textContent).toContain('Connect to bee to open a terminal.')
  expect(attempts).toBe(0)
  const owner = terminalOwner(machineTarget(MOCK_HOST_ID, null))
  expect(useTerminalStore.getState().byOwner[owner]).toBeUndefined()
})
