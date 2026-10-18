import { expect, it, vi } from 'vitest'
import { createAccountReservations } from './account-reservations'

it('keeps nested reservations until all holders exit, including failure paths', async () => {
  const remove = vi.fn(async () => {})
  const accounts = createAccountReservations(remove)
  await expect(
    accounts.withAccount('a', () =>
      accounts.withAccount('a', async () => {
        await expect(accounts.removeAccount('a')).rejects.toThrow('in use')
        throw new Error('startup failed')
      }),
    ),
  ).rejects.toThrow('startup failed')
  await accounts.removeAccount('a')
  expect(remove).toHaveBeenCalledExactlyOnceWith('a', undefined)
})

it('rejects move admission after removal starts and releases a failed removal', async () => {
  let fail!: (error: Error) => void
  const pending = new Promise<void>((_resolve, reject) => (fail = reject))
  const remove = vi.fn(() => pending)
  const accounts = createAccountReservations(remove)
  const removal = accounts.removeAccount('a')
  const moved = vi.fn(async () => {})
  await expect(accounts.withAccount('a', moved)).rejects.toThrow('in use')
  await expect(accounts.removeAccount('a')).rejects.toThrow('in use')
  expect(moved).not.toHaveBeenCalled()
  fail(new Error('logout failed'))
  await expect(removal).rejects.toThrow('logout failed')
  await accounts.withAccount('a', moved)
  expect(moved).toHaveBeenCalledOnce()
})

it('does not reserve other accounts or another Host domain', async () => {
  const a = createAccountReservations(vi.fn(async () => {}))
  const remove = vi.fn(async () => {})
  const b = createAccountReservations(remove)
  await a.withAccount('a', async () => {
    await a.removeAccount('b')
    await b.removeAccount('a')
  })
  expect(remove).toHaveBeenCalledOnce()
})
