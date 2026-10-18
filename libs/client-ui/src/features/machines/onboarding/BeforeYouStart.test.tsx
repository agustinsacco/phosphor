// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BeforeYouStart } from './BeforeYouStart'

it.each([
  ['ready', 'MagicDNS and HTTPS certificates are available'],
  ['not-installed', 'Install Tailscale on this computer'],
  ['not-running', 'Open Tailscale and connect'],
  ['signed-out', 'Sign in to Tailscale'],
  ['magicdns-unavailable', 'Turn on MagicDNS'],
  ['https-unavailable', 'Turn on HTTPS certificates'],
  ['check-failed', 'Could not check Tailscale'],
])('keeps the read-only readiness check and specific fix for %s', async (code, message) => {
  const invoke = vi.fn(async (channel: string) =>
    channel === 'account:get' ? { account: { status: 'signed-in' } } : { code },
  )
  vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BeforeYouStart />))
    expect(container.textContent).toContain(message)
    expect(container.textContent).not.toContain('SSH')
    expect(container.querySelector('[role=switch]')).toBeNull()
    expect(container.textContent).not.toContain('Suggest machines')
    expect(container.textContent).toContain('Tailscale on this computer')
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Check again')
        ?.click(),
    )
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'hosts:tailscaleStatus'),
    ).toHaveLength(2)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('settles a rejected readiness check without blocking Install', async () => {
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'account:get') return { account: { status: 'signed-in' } }
      throw new Error('unavailable')
    }),
    onAccountChanged: () => () => {},
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BeforeYouStart />))
    expect(container.textContent).toContain('Could not check Tailscale')
    expect(container.textContent).not.toContain('Checking Tailscale')
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Check again')
        ?.disabled,
    ).toBe(false)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
