import { expect, it, vi } from 'vitest'
import { createAccountControls } from './controls'
import type { Account } from './account'

it('reads the account at launch and starts sign-in without an opt-in gate', () => {
  const account: Account = {
    state: () => ({ status: 'signed-out' }),
    load: () => ({ status: 'signed-out' }),
    signIn: vi.fn(async () => ({ status: 'signing-in' as const })),
    cancel: () => undefined,
    signOut: async () => ({ status: 'signed-out' }),
    accessToken: async () => null,
    settled: async () => true,
  }
  const read = vi.fn(() => account)
  const controls = createAccountControls({
    account: read,
    view: (state) => ({
      account:
        state.status === 'signed-in'
          ? { ...state, user: { login: null, name: null, email: null } }
          : state,
    }),
  })
  expect(controls.snapshot()).toEqual({ account: { status: 'signed-out' } })
  expect(read).toHaveBeenCalledOnce()
  controls.signIn()
  expect(account.signIn).toHaveBeenCalledOnce()
})
