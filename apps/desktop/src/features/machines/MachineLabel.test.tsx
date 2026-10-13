// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineLabel } from './MachineLabel'
import { MACHINE } from './__fixtures__/control'
import { useMachinesStore } from '@/stores/machines'
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
const saved = vi.fn()
beforeEach(async () => {
  invoke.mockReset()
  saved.mockReset()
  vi.stubGlobal('phosphor', { invoke })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<MachineLabel machine={MACHINE} onSaved={saved} />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useMachinesStore.getState().enableRemote(false)
  vi.unstubAllGlobals()
})
const edit = async (value: string): Promise<void> => {
  act(() => container.querySelector('button')?.click())
  act(() => {
    const input = container.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = async (value: string): Promise<void> => {
  await act(async () =>
    container
      .querySelector('input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })),
  )
}
it('saves a normalized inline label on Enter and uses the parsed machine reply', async () => {
  invoke.mockResolvedValue({ ok: true, machine: { ...MACHINE, label: 'buildbox' } })
  await edit(' buildbox ')
  await key('Enter')
  expect(invoke).toHaveBeenCalledExactlyOnceWith('control:renameMachine', MACHINE.id, 'buildbox')
  expect(saved).toHaveBeenCalledWith({ ...MACHINE, label: 'buildbox' })
  expect(container.querySelector('input')).toBeNull()
})
it('saves on blur, but Escape and an unchanged label make no request', async () => {
  await edit('other')
  await key('Escape')
  expect(invoke).not.toHaveBeenCalled()
  expect(container.textContent).toContain(MACHINE.label)
  await edit(MACHINE.label)
  await key('Enter')
  expect(invoke).not.toHaveBeenCalled()
  invoke.mockResolvedValue({ ok: true, machine: { ...MACHINE, label: 'other' } })
  await edit('other')
  await act(async () =>
    container.querySelector('input')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
  )
  expect(invoke).toHaveBeenCalledExactlyOnceWith('control:renameMachine', MACHINE.id, 'other')
})
it('rejects empty or control-character labels inline and accepts the exact length limit', async () => {
  for (const value of ['', 'hidden\u202e', 'a'.repeat(81)]) {
    await edit(value)
    await key('Enter')
    expect(invoke).not.toHaveBeenCalled()
    expect(container.querySelector('[role=alert]')?.textContent).toContain('1 to 80')
    await key('Escape')
  }
  invoke.mockResolvedValue({ ok: true, machine: { ...MACHINE, label: 'a'.repeat(80) } })
  await edit('a'.repeat(80))
  await key('Enter')
  expect(invoke).toHaveBeenCalledWith('control:renameMachine', MACHINE.id, 'a'.repeat(80))
})
it.each(['offline', 'not-found'])(
  'rolls back to the saved label and shows %s inline',
  async (code) => {
    invoke.mockResolvedValue({ ok: false, error: { code } })
    await edit('other')
    await key('Enter')
    expect(container.querySelector('h1')?.textContent).toBe(MACHINE.label)
    expect(container.querySelector('[role=alert]')).not.toBeNull()
    expect(saved).not.toHaveBeenCalled()
  },
)
it('does not apply a late reply after sign-out and sign-in', async () => {
  invoke.mockImplementation(async () => {
    useMachinesStore.setState({ remoteEnabled: true })
    useMachinesStore.getState().enableRemote(false)
    useMachinesStore.setState({ remoteEnabled: true })
    return { ok: true, machine: { ...MACHINE, label: 'other' } }
  })
  await edit('other')
  await key('Enter')
  expect(saved).not.toHaveBeenCalled()
})
it('returns focus to Rename after Escape and after a save', async () => {
  const rename = (): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Rename')
  await edit('other')
  await key('Escape')
  expect(document.activeElement).toBe(rename())
  invoke.mockResolvedValue({ ok: true, machine: { ...MACHINE, label: 'other' } })
  await edit('other')
  await key('Enter')
  expect(document.activeElement).toBe(rename())
})
