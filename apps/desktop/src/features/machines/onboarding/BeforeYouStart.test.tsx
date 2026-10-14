// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BeforeYouStart } from './BeforeYouStart'
import { useMachinesStore } from '@/stores/machines'

it('opt-in only reads status; picking a peer only prefills, without installing or enrolling', async () => {
  let enabled = false
  const invoke = vi.fn(async (channel: string, value?: boolean) => {
    if (channel === 'account:get') return { account: { status: 'signed-in' } }
    if (channel === 'hosts:setTailscaleDiscovery') enabled = value === true
    if (channel === 'hosts:tailscaleStatus')
      return {
        code: 'ready',
        discovery: enabled,
        peers: enabled ? [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }] : [],
      }
    return undefined
  })
  vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => undefined })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ machines: [] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const pick = vi.fn()
  try {
    await act(async () => root.render(<BeforeYouStart onPick={pick} />))
    expect(container.textContent).not.toContain('bee.tail123.ts.net')
    expect(container.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
    await act(async () => container.querySelector<HTMLButtonElement>('[role=switch]')?.click())
    expect(invoke).toHaveBeenCalledWith('hosts:setTailscaleDiscovery', true)
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('bee.tail123.ts.net'),
    )!
    await act(async () => button.click())
    expect(pick).toHaveBeenCalledWith('bee.tail123.ts.net')
    expect(
      invoke.mock.calls.every(([channel]) =>
        ['account:get', 'hosts:tailscaleStatus', 'hosts:setTailscaleDiscovery'].includes(channel),
      ),
    ).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('[role=switch]')?.click())
    expect(container.textContent).not.toContain('bee.tail123.ts.net')
    expect(invoke).toHaveBeenCalledWith('hosts:setTailscaleDiscovery', false)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
