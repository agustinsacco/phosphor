// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { PhosphorAccountSection } from './PhosphorAccountSection'

interface Pending {
  channel: string
  resolve(value: unknown): void
  reject(error: unknown): void
}

let root: Root
let container: HTMLDivElement
let push: (view: AccountView) => void
const pending: Pending[] = []
const original = window.phosphor
const signedOut: AccountView = { preview: true, account: { status: 'signed-out' } }
const signingIn: AccountView = { preview: true, account: { status: 'signing-in' } }

const text = (): string => container.textContent ?? ''
const button = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name)
const reply = async (channel: string, settle: (p: Pending) => void): Promise<void> => {
  const index = pending.findIndex((p) => p.channel === channel)
  expect(index).toBeGreaterThanOrEqual(0)
  await act(async () => settle(pending.splice(index, 1)[0]!))
}

beforeEach(() => {
  pending.length = 0
  window.phosphor = {
    invoke: vi.fn(
      (channel: string) =>
        new Promise((resolve, reject) => pending.push({ channel, resolve, reject })),
    ),
    onAccountChanged: (listener: typeof push) => {
      push = listener
      return () => undefined
    },
  } as unknown as typeof window.phosphor
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<PhosphorAccountSection />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.phosphor = original
})

it('keeps a newer push over an action reply that was sent before it', async () => {
  await reply('account:get', (p) => p.resolve(signedOut))
  act(() => button('Sign in with GitHub')!.click())
  act(() => push(signingIn))
  expect(text()).toContain('Waiting for you to finish in your browser.')
  // Another window cancels; its push overtakes this sign-in's own reply.
  act(() => push(signedOut))
  await reply('account:signIn', (p) => p.resolve(signingIn))
  expect(text()).not.toContain('Waiting for you')
  expect(button('Sign in with GitHub')).toBeDefined()
})

it('lets a push that lands before the first read win over it', async () => {
  act(() => push(signingIn))
  await reply('account:get', (p) => p.resolve(signedOut))
  expect(text()).toContain('Waiting for you to finish in your browser.')
})

it('says why the account could not be read, without Electron’s wrapper', async () => {
  const error = new Error(
    "Error invoking remote method 'account:get': Error: PHOSPHOR_SUPABASE_URL needs PHOSPHOR_SUPABASE_KEY",
  )
  await reply('account:get', (p) => p.reject(error))
  expect(text()).toBe('Phosphor accountPHOSPHOR_SUPABASE_URL needs PHOSPHOR_SUPABASE_KEY')
})

it('shows a refused action, and shows nothing while the preview is off', async () => {
  await reply('account:get', (p) => p.resolve(signedOut))
  act(() => button('Sign in with GitHub')!.click())
  await reply('account:signIn', (p) =>
    p.reject(new Error("Error invoking remote method 'account:signIn': Error: turn it on")),
  )
  expect(text()).toContain('turn it on')
  expect(text()).not.toContain('Error invoking')
  act(() => push({ preview: false, account: { status: 'signed-out' } }))
  expect(text()).toBe('')
})

it('shows the plain-file disclosure for a remembered session', async () => {
  const note = 'Saved in a file only your user can read, because no keyring is running.'
  await reply('account:get', (p) =>
    p.resolve({
      preview: true,
      account: {
        status: 'signed-in',
        user: { login: 'octo', name: null, email: null },
        remembered: true,
        storageNote: note,
      },
    }),
  )
  expect(text()).toContain(note)
  expect(text()).not.toContain('Until Phosphor quits')
  expect(button('Sign out')).toBeDefined()
})
