import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Account, AccountPorts, AccountState } from '../account/account'

const fake = vi.hoisted(() => {
  const state: {
    preview: boolean
    token: string | null
    account: AccountState
    onChange: ((state: AccountState) => void) | null
  } = { preview: false, token: null, account: { status: 'signed-out' }, onChange: null }
  return { state, accessToken: vi.fn(async () => state.token), build: vi.fn() }
})
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/unused' },
  safeStorage: {},
  shell: {},
}))
vi.mock('../store', () => ({
  getAccountPreview: () => fake.state.preview,
  setAccountPreview: () => undefined,
}))
vi.mock('../broadcast', () => ({ broadcast: () => undefined }))
vi.mock('../debug-log', () => ({ log: () => undefined }))
vi.mock('../account/config', () => ({
  keychainOff: () => true,
  supabaseTarget: () => ({ url: 'https://example.test', key: '' }),
}))
vi.mock('../account/vault', () => ({
  createVault: () => ({ storage: () => ({ ok: false, reason: '' }) }),
}))
vi.mock('../account/account', () => ({
  createAccount: (ports: AccountPorts): Account => {
    fake.build()
    fake.state.onChange = ports.onChange
    return {
      state: () => fake.state.account,
      load: () => fake.state.account,
      signIn: async () => ({ status: 'signed-out' }),
      signOut: async () => ({ status: 'signed-out' }),
      cancel: () => undefined,
      accessToken: fake.accessToken,
      settled: async () => true,
    }
  },
}))

it('keeps preview-off access local and exposes only a non-secret cache generation', async () => {
  const { accountAccessToken, accountControlGeneration } = await import('../account')
  expect(await accountAccessToken()).toBeNull()
  expect(fake.build).not.toHaveBeenCalled()
  expect(fake.accessToken).not.toHaveBeenCalled()
  fake.state.preview = true
  expect(await accountAccessToken()).toBeNull()
  expect(fake.accessToken).not.toHaveBeenCalled()
  fake.state.token = randomBytes(32).toString('base64url')
  fake.state.account = {
    status: 'signed-in',
    remembered: false,
    user: { id: 'unused', login: null, name: null, email: null },
  }
  expect(await accountAccessToken()).toBe(fake.state.token)
  const generation = accountControlGeneration()
  fake.state.onChange?.(fake.state.account)
  expect(accountControlGeneration()).toBe(generation)
  fake.state.onChange?.({ status: 'signed-out' })
  expect(accountControlGeneration()).toBe(generation + 1)
  fake.state.onChange?.({ status: 'signing-in' })
  expect(accountControlGeneration()).toBe(generation + 2)
  fake.accessToken.mockImplementationOnce(async () => {
    fake.state.preview = false
    return fake.state.token
  })
  expect(await accountAccessToken()).toBeNull()
  fake.state.preview = false
  const calls = fake.accessToken.mock.calls.length
  expect(await accountAccessToken()).toBeNull()
  expect(fake.accessToken).toHaveBeenCalledTimes(calls)
})

it('publishes only account views, isolates throwing listeners and unsubscribes', async () => {
  const { onAccountChange } = await import('../account')
  const throwing = vi.fn(() => {
    throw new Error('listener failed')
  })
  const receive = vi.fn()
  const offThrow = onAccountChange(throwing)
  const off = onAccountChange(receive)
  fake.state.onChange?.({ status: 'signed-out' })
  expect(receive).toHaveBeenCalledWith({ preview: false, account: { status: 'signed-out' } })
  off()
  offThrow()
  fake.state.onChange?.({ status: 'signed-out' })
  expect(receive).toHaveBeenCalledOnce()
})
