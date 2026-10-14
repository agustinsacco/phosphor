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
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Use bee.tail123.ts.net',
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

it.each(['save', 'status', 'initial'] as const)(
  'handles %s failure without stale peers or indefinite checking',
  async (failure) => {
    let reads = 0
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'account:get') return { account: { status: 'signed-in' } }
      if (channel === 'hosts:setTailscaleDiscovery' && failure === 'save') throw new Error('save')
      if (channel === 'hosts:tailscaleStatus') {
        if (++reads > 1 || failure === 'initial') throw new Error('status')
        return {
          code: 'ready',
          discovery: true,
          peers: [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }],
        }
      }
      return undefined
    })
    vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => undefined })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<BeforeYouStart onPick={() => {}} />))
      if (failure !== 'initial')
        await act(async () => container.querySelector<HTMLButtonElement>('[role=switch]')?.click())
      if (failure === 'save') {
        expect(container.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('true')
        expect(container.textContent).toContain('Could not save discovery')
        expect(container.textContent).toContain('bee.tail123.ts.net')
      } else {
        expect(container.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
        expect(container.textContent).not.toContain('bee.tail123.ts.net')
        expect(container.textContent).toContain('Could not check Tailscale. Open Tailscale')
        expect(container.textContent).not.toContain('Checking Tailscale')
      }
    } finally {
      act(() => root.unmount())
      vi.unstubAllGlobals()
    }
  },
)

it('shows check hierarchy, failure-specific fixes and loading, empty and usable discovery rows', async () => {
  let finish: (value: unknown) => void = () => {}
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'account:get') return { account: { status: 'signed-in' } }
    if (channel === 'hosts:tailscaleStatus')
      return new Promise((resolve) => {
        finish = resolve
      })
    return undefined
  })
  vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  const complete = async (code: string, peers: unknown[] = []) =>
    act(async () => finish({ code, discovery: true, peers }))
  const check = async () =>
    act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Check again')
        ?.click(),
    )
  try {
    await act(async () => root.render(<BeforeYouStart onPick={() => {}} />))
    expect(container.querySelector('[aria-label=Checking]')).not.toBeNull()
    await complete('ready')
    expect(container.querySelectorAll('[aria-label=Passed]')).toHaveLength(2)
    expect(container.textContent).not.toContain('Install Tailscale')
    expect(container.textContent).not.toContain('Tailscale DNS and HTTPS help')
    expect(container.textContent).toContain('Suggest machines from my tailnet')
    expect(container.textContent).toContain(
      'Off by default. Suggestions only fill in the SSH address; nothing connects until you install.',
    )
    expect(container.textContent).toContain('No other online machines found on your tailnet.')
    await check()
    expect(container.textContent).toContain('Loading suggestions…')
    await complete('ready', [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }])
    expect(container.querySelector('li .font-semibold')?.textContent).toBe('bee')
    expect(container.querySelector('li [aria-label=linux]')).not.toBeNull()
    expect(
      container.querySelector('button[aria-label="Use bee.tail123.ts.net"]')?.textContent,
    ).toBe('Use')
    await check()
    await complete('not-installed')
    expect(container.querySelector('[aria-label="Needs attention"]')).not.toBeNull()
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Install Tailscale'),
    ).toBe(true)
    expect(container.textContent).not.toContain('Tailscale DNS and HTTPS help')
    await check()
    await complete('https-unavailable')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Install Tailscale'),
    ).toBe(false)
    expect(container.textContent).toContain('Tailscale DNS and HTTPS help')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('only lets idle installations use discovery targets', async () => {
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel) =>
      channel === 'account:get'
        ? { account: { status: 'signed-in' } }
        : {
            code: 'ready',
            discovery: true,
            peers: [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }],
          },
    ),
    onAccountChanged: () => () => {},
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  const pick = vi.fn()
  const back = vi.fn()
  const render = async (active: boolean) =>
    act(async () =>
      root.render(<BeforeYouStart onPick={pick} installActive={active} onReturnToInstall={back} />),
    )
  try {
    await render(true)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Use bee.tail123.ts.net"]')
        ?.click(),
    )
    expect(pick).not.toHaveBeenCalled()
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Return to Install')
        ?.click(),
    )
    expect(back).toHaveBeenCalledOnce()
    await render(false)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Use bee.tail123.ts.net"]')
        ?.click(),
    )
    expect(pick).toHaveBeenCalledWith('bee.tail123.ts.net')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
