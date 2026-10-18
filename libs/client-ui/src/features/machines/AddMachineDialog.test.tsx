// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AddMachineDialog } from './AddMachineDialog'
import { MACHINE, LOOKUP } from './__fixtures__/control'
import { useMachinesStore } from '@/stores/machines'

const command =
  'curl -fsSL https://github.com/agustinsacco/Phosphor/releases/download/host-latest/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && phosphor setup'

it('shows and copies the exact one-command install, then enters the code and approves the fingerprint', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'account:get') return { account: { status: 'signed-in' } }
    if (channel === 'hosts:tailscaleStatus') return { code: 'ready' }
    if (channel === 'control:lookupEnrollment') return { ok: true, ...LOOKUP }
    if (channel === 'control:approveEnrollment') return { ok: true, machine: MACHINE }
    if (channel === 'control:machines')
      return { ok: true, machines: [MACHINE], serverTime: new Date().toISOString() }
    return undefined
  })
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => {} })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ remoteEnabled: true, machines: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = async (name: string) =>
    act(async () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === name)
      expect(button, name).toBeDefined()
      button?.click()
    })
  try {
    await act(async () => root.render(<AddMachineDialog onClose={() => {}} />))
    expect(document.body.textContent).not.toContain('Suggest machines')
    await click('Continue to Install')
    expect(document.querySelector('pre code')?.textContent).toBe(command)
    expect(document.body.textContent).toContain('PHOSPHOR_NO_MODIFY_PATH=1')
    expect(document.body.textContent).toContain('shell startup file')
    expect(document.body.textContent).not.toContain('SSH')
    await click('Copy')
    expect(writeText).toHaveBeenCalledWith(command)
    await click('Back')
    await click('Continue to Install')
    await click('I have a code')
    const codeInput = document.querySelector('input')
    expect(codeInput?.closest('label')?.textContent).toContain('Code')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        codeInput,
        'BCDFGHJK',
      )
      codeInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Look up code')
    expect(invoke).toHaveBeenCalledWith('control:lookupEnrollment', 'BCDFGHJK')
    expect(document.body.textContent).toContain(
      'Compare this fingerprint with what phosphor setup printed',
    )
    expect(document.querySelector('pre code')?.textContent).toBe(LOOKUP.keyFingerprint)
    await click('Approve machine')
    expect(invoke).toHaveBeenCalledWith('control:approveEnrollment', 'BCDFGHJK', LOOKUP.hostname)
    expect(document.body.textContent).toContain('bee1 added')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
