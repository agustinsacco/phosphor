// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SshInstallEvent } from '@shared/ssh-install'
import { AddMachineDialog } from './AddMachineDialog'
import { MACHINE, LOOKUP } from './__fixtures__/control'
import { useMachinesStore } from '@/stores/machines'

it('preserves the SSH job, input and progress through Back before and after fingerprint delivery', async () => {
  let event: (event: SshInstallEvent) => void = () => {}
  const off = vi.fn()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'account:get') return { account: { status: 'signed-in' } }
    if (channel === 'hosts:tailscaleStatus')
      return {
        code: 'ready',
        discovery: true,
        peers: [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }],
      }
    if (channel === 'hosts:sshInstall') return { jobId: 'job' }
    if (channel === 'control:lookupEnrollment') return { ok: true, ...LOOKUP }
    if (channel === 'control:approveEnrollment') return { ok: true, machine: MACHINE }
    if (channel === 'control:machines')
      return { ok: true, machines: [MACHINE], serverTime: new Date().toISOString() }
    return undefined
  })
  vi.stubGlobal('phosphor', {
    invoke,
    onAccountChanged: () => () => {},
    onSshInstall: (_id: string, callback: typeof event) => {
      event = callback
      return off
    },
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ remoteEnabled: true, machines: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = async (name: string) =>
    act(async () => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === name || b.getAttribute('aria-label') === name,
      )
      expect(button, name).toBeDefined()
      button?.click()
    })
  try {
    await act(async () => root.render(<AddMachineDialog onClose={() => {}} />))
    await click('Use bee.tail123.ts.net')
    const steps = document.querySelectorAll('ol[aria-label="Setup steps"] li')
    expect(steps[0]?.querySelector('[aria-label=Completed]')).not.toBeNull()
    expect(steps[1]?.getAttribute('aria-current')).toBe('step')
    expect(steps[1]?.className).toContain('text-accent')
    expect(steps[2]?.className).not.toContain('text-accent')
    const repository = document.querySelectorAll('input')[1]!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        repository,
        'src/project',
      )
      repository.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Install Host')
    await act(async () => event({ kind: 'progress', step: 'install' }))
    await click('Back')
    const usePeer = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use bee.tail123.ts.net"]',
    )!
    expect(usePeer.disabled).toBe(true)
    expect(document.body.textContent).toContain('An SSH installation is already in progress.')
    await act(async () => usePeer.click())
    expect(document.querySelector('[aria-label="Before you start"]')).not.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('hosts:sshInstallCancel', 'job')
    expect(off).not.toHaveBeenCalled()
    await click('Return to Install')
    expect(document.querySelectorAll('input')[1]?.value).toBe('src/project')
    expect(document.body.textContent).toContain('Host install is running.')
    await act(async () =>
      event({
        kind: 'enrollment',
        step: 'login',
        code: 'BCDFGHJK',
        fingerprint: MACHINE.keyFingerprint,
      }),
    )
    await click('Back') // confirm -> code
    await click('Back') // code -> install
    await click('Back') // install -> prerequisites
    await click('Continue to Install')
    expect(document.body.textContent).toContain('Waiting for approval below.')
    await click('I have a code')
    await click('Look up code')
    await click('Approve machine')
    expect(document.body.textContent).toContain('Finishing install')
    await act(async () => event({ kind: 'done', step: 'service' }))
    expect(document.body.textContent).toContain('bee1 added')
    expect(invoke).not.toHaveBeenCalledWith('hosts:sshInstallCancel', 'job')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
