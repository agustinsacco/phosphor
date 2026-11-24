import { expect, it, vi } from 'vitest'
import { OwnerCallError, ownerCall } from './owner'

const migrationId = '00000000-0000-4000-8000-000000000001'
function connection(
  result:
    { ok: true; data: unknown } | { ok: false; error: { code: 'unsupported'; message: string } },
) {
  return { call: vi.fn(async () => ({ type: 'result' as const, id: 'c', ...result })) }
}

it('sends checked params and returns the typed result', async () => {
  const c = connection({ ok: true, data: { state: 'staged' } })
  await expect(ownerCall(c, 'owner.migrate.status', { migrationId })).resolves.toEqual({
    state: 'staged',
  })
  expect(c.call).toHaveBeenCalledExactlyOnceWith('owner.migrate.status', { migrationId })
})

it('sends no params for a paramless method', async () => {
  const c = connection({ ok: true, data: { mode: 'local' } })
  await ownerCall(c, 'machine.identity.reload', undefined)
  expect(c.call).toHaveBeenCalledExactlyOnceWith('machine.identity.reload', undefined)
})

it('refuses invalid params before sending', async () => {
  const c = connection({ ok: true, data: null })
  await expect(ownerCall(c, 'owner.migrate.status', { migrationId: '../x' })).rejects.toThrow(
    'Invalid owner.migrate.status params.',
  )
  expect(c.call).not.toHaveBeenCalled()
})

it("carries the daemon's refusal code, as an older daemon answers unsupported", async () => {
  const c = connection({ ok: false, error: { code: 'unsupported', message: 'unsupported' } })
  const error = await ownerCall(c, 'machine.local', undefined).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OwnerCallError)
  expect(error).toMatchObject({ code: 'unsupported', message: 'unsupported' })
})
