// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SshInstallEvent } from '@shared/ssh-install'
import { AddMachineDialog } from './AddMachineDialog'
import { useMachinesStore } from '@/stores/machines'
import { LOOKUP, MACHINE } from './__fixtures__/control'

let root: Root
let container: HTMLDivElement
let push: (event: SshInstallEvent) => void
let lookupFingerprint: string
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'hosts:sshInstall') return { jobId: 'job' }
  if (channel === 'control:lookupEnrollment')
    return { ok: true, ...LOOKUP, keyFingerprint: lookupFingerprint }
  if (channel === 'control:approveEnrollment') return { ok: true, machine: MACHINE }
  if (channel === 'control:machines')
    return { ok: true, machines: [MACHINE], serverTime: new Date().toISOString() }
  return undefined
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockClear()
  lookupFingerprint = 'abcd-1234-5678-90ef'
  push = () => undefined
  vi.stubGlobal('phosphor', {
    invoke,
    onSshInstall: (_job: string, listener: typeof push) => {
      push = listener
      return () => undefined
    },
  })
  useMachinesStore.setState({ remoteEnabled: true, machines: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (entry) => entry.textContent === text,
  )
  expect(button, text).toBeDefined()
  await act(async () => button?.click())
}
async function input(label: string, value: string) {
  const element = Array.from(document.querySelectorAll('input')).find((entry) =>
    entry.closest('label')?.textContent?.includes(label),
  )
  expect(element).toBeDefined()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function start() {
  await act(async () => root.render(<AddMachineDialog onClose={() => undefined} />))
  await click('Install over SSH')
  await input('SSH target', 'alice@bee')
  await input('Repository on that machine', 'src/project')
  await click('Install Host')
  expect(invoke).toHaveBeenCalledWith('hosts:sshInstall', 'alice@bee', 'src/project')
}
it('shows progress, inline code and both fingerprints, then uses existing approval and service completion', async () => {
  await start()
  await act(async () => push({ kind: 'progress', step: 'setup' }))
  expect(document.body.textContent).toContain('Host setup is running.')
  await act(async () =>
    push({ kind: 'enrollment', step: 'login', code: 'BCDFGHJK', fingerprint: lookupFingerprint }),
  )
  expect(invoke).toHaveBeenCalledWith('control:lookupEnrollment', 'BCDFGHJK')
  expect(document.body.textContent).toContain('Host fingerprint: abcd-1234-5678-90ef')
  expect(document.body.textContent?.match(/abcd-1234-5678-90ef/g)).toHaveLength(2)
  await click('Approve machine')
  expect(invoke).toHaveBeenCalledWith('control:approveEnrollment', 'BCDFGHJK', LOOKUP.hostname)
  await act(async () => push({ kind: 'done', step: 'service' }))
  expect(document.body.textContent).toContain('Host service installed.')
})
it('refuses mismatch and cannot approve a previous or mismatched enrollment', async () => {
  await start()
  await act(async () =>
    push({
      kind: 'enrollment',
      step: 'login',
      code: 'BCDFGHJK',
      fingerprint: '0000-0000-0000-0000',
    }),
  )
  expect(document.body.textContent).toContain('The fingerprints do not match.')
  expect(document.body.textContent).not.toContain('Approve machine')
  expect(invoke.mock.calls.some(([channel]) => channel === 'control:approveEnrollment')).toBe(false)
})
it('shows bounded remote failure details, focuses repository, retries and cancels on close', async () => {
  await start()
  await act(async () =>
    push({
      kind: 'failed',
      step: 'setup',
      message: 'Choose a repository on that machine and try again',
      output: ['remote failure'],
    }),
  )
  expect(document.body.textContent).toContain('Choose a repository on that machine and try again')
  expect(document.activeElement?.closest('label')?.textContent).toContain(
    'Repository on that machine',
  )
  expect(document.querySelector('details pre')?.textContent).toBe('remote failure')
  await click('Try again')
  await click('Cancel install')
  expect(invoke).toHaveBeenCalledWith('hosts:sshInstallCancel', 'job')
  await act(async () => push({ kind: 'cancelled', step: 'install' }))
  expect(document.body.textContent).toContain('Installation cancelled.')
  await click('Install Host')
  act(() => root.render(null))
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'hosts:sshInstallCancel'),
  ).toHaveLength(2)
})
