// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { MachineTerminal } from './MachineTerminal'

vi.mock('@/features/terminal/TerminalView', () => ({
  TerminalView: ({ ptyId }: { ptyId: string }) => <div data-shell={ptyId}>Shell attached</div>,
}))
let root: Root
let el: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
let attempts: number
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  attempts = 0
  fake = createFakePhosphor({
    'hosts:machineShell': () => {
      if (++attempts === 1) throw new Error('temporarily offline')
      return { ptyId: 'remote-pty-shell' }
    },
    'pty:kill': () => {
      throw new Error('could not stop shell')
    },
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.machineShell = true
  host.capabilities.push('terminal')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
function button(text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
it('recovers after the first open fails; hiding detaches and a failed End stays visible', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <MachineTerminal hostId={MOCK_HOST_ID} label="bee" />
      </PlatformProvider>,
    ),
  )
  expect(attempts).toBe(0)
  await act(async () => button('Open terminal').click())
  expect(el.textContent).toContain('temporarily offline')
  await act(async () => button('Open terminal').click())
  expect(el.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('remote-pty-shell')
  await act(async () => button('End shell').click())
  expect(el.textContent).toContain('could not stop shell')
  expect(el.querySelector('[data-shell]')).not.toBeNull()
  await act(async () => button('Hide').click())
  expect(el.querySelector('[data-shell]')).toBeNull()
  expect(attempts).toBe(2)
})
