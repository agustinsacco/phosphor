import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { BRAIN_ACCESS, type BrainAccess } from '@phosphor/shared/brain-access'
import { BRAIN_APPROVAL, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import { createBrainAdapter, type BrainSurfaceHandlers } from './brain-adapter'
import { bindBrainLink } from './__fixtures__/brain-link'

const bind = bindBrainLink
// Brain Agent's conversation takes every Brain right, and sessions.control from a grant user.
const ALL = BRAIN_ACCESS
const grantUser = (adapter: Parameters<typeof bind>[1], rights: readonly BrainAccess[] = ALL) =>
  bind('grant-user', adapter, rights, undefined, ['sessions.control'])
const tell = { method: 'brain:tell', args: ['Rina Okafor'] }

it('admits only signed/attested interactive rights; claimed prompts and actor fields do not change identity', async () => {
  const h = vi.fn(() => ({ status: 'ok' as const, data: null }))
  const adapter = createBrainAdapter({ 'brain:tell': h } as unknown as BrainSurfaceHandlers)
  const machine = bind('grant-machine', adapter, ALL, undefined, ['sessions.control'])
  const signed = grantUser(adapter)
  expect(await machine.run(BRAIN_SURFACE, tell, true)).toMatchObject({
    status: 'denied',
    code: 'forbidden',
  })
  expect(await signed.run(BRAIN_SURFACE, tell, true, { actor: { kind: 'agent' } })).toMatchObject({
    status: 'denied',
    code: 'forbidden',
  })
  expect(await signed.run(BRAIN_SURFACE, tell)).toMatchObject({
    status: 'denied',
    code: 'bad-request',
  })
  expect(await signed.run(BRAIN_SURFACE, tell, true)).toMatchObject({ status: 'ok', data: null })
  expect(h).toHaveBeenCalledTimes(1)
})

it('does not revive an in-flight handler or publish its result after loss and regrant', async () => {
  let release: (() => void) | undefined
  const h: BrainSurfaceHandlers['brain:tell'] = (_request, authority) =>
    new Promise((resolve) => {
      release = () => {
        expect(authority.admit()).toBe(false)
        resolve({ status: 'ok', data: null })
      }
    })
  const surface = grantUser(
    createBrainAdapter({ 'brain:tell': h } as unknown as BrainSurfaceHandlers),
  )
  const result = surface.run(BRAIN_SURFACE, tell, true)
  surface.renew()
  surface.renew(ALL)
  release!()
  expect(await result).toMatchObject({ status: 'denied', code: 'forbidden' })
})

it('binds a local approval to one connection, digest, exact action, and live approver', async () => {
  const h = vi.fn(() => ({ status: 'ok' as const, data: null }))
  const adapter = createBrainAdapter({ 'brain:tell': h } as unknown as BrainSurfaceHandlers)
  const sameClient = randomUUID()
  const cli = bind('local', adapter, [], sameClient)
  const spoof = bind('local', adapter, [], sameClient)
  const reader = grantUser(adapter, ['read'])
  const owner = bind('owner', adapter, ALL)
  const ask = await cli.run(BRAIN_SURFACE, tell, true)
  expect(ask.status).toBe('confirm')
  if (ask.status !== 'confirm') throw Error('Expected approval request')
  expect(JSON.stringify(ask)).not.toContain('Rina Okafor')
  const confirm = { confirmId: ask.confirmId, digest: ask.digest }
  const answer = { action: 'answer', id: ask.confirmId, approved: true }
  expect(await reader.run(BRAIN_APPROVAL, answer, true)).toMatchObject({ status: 'denied' })
  expect(await owner.run(BRAIN_APPROVAL, answer, true)).toMatchObject({ status: 'ok' })
  expect(await spoof.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({
    status: 'denied',
  })
  expect(
    await cli.run(BRAIN_SURFACE, { ...tell, args: ['Mara Voss'] }, true, { confirm }),
  ).toMatchObject({ status: 'denied' })
  expect(await cli.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({ status: 'ok' })
  expect(await cli.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({ status: 'denied' })
  const another = await cli.run(BRAIN_SURFACE, tell, true)
  if (another.status !== 'confirm') throw Error('Expected another approval request')
  await owner.run(BRAIN_APPROVAL, { ...answer, id: another.confirmId }, true)
  owner.renew([])
  expect(
    await cli.run(BRAIN_SURFACE, tell, true, {
      confirm: { confirmId: another.confirmId, digest: another.digest },
    }),
  ).toMatchObject({ status: 'denied' })
  expect(h).toHaveBeenCalledTimes(1)
})

it('exposes pending approvals only to entitled surfaces and never treats pending as answered', async () => {
  const h = vi.fn(() => ({ status: 'ok' as const, data: null }))
  const adapter = createBrainAdapter({ 'brain:tell': h } as unknown as BrainSurfaceHandlers)
  const cli = bind('local', adapter)
  const machine = bind('grant-machine', adapter, ALL, undefined, ['sessions.control'])
  const read = grantUser(adapter, ['read'])
  const control = grantUser(adapter)
  const ask = await cli.run(BRAIN_SURFACE, tell, true)
  if (ask.status !== 'confirm') throw Error('Expected Brain approval request')
  const confirm = { confirmId: ask.confirmId, digest: ask.digest }
  const list = { action: 'list' }
  expect(await cli.run(BRAIN_APPROVAL, list)).toMatchObject({ status: 'denied' })
  expect(await machine.run(BRAIN_APPROVAL, list)).toMatchObject({ status: 'denied' })
  expect(await read.run(BRAIN_APPROVAL, list)).toMatchObject({ status: 'ok', data: [] })
  expect(await control.run(BRAIN_APPROVAL, list)).toMatchObject({
    status: 'ok',
    data: [{ ...confirm, state: 'pending' }],
  })
  expect(await cli.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({ status: 'denied' })
  expect(h).not.toHaveBeenCalled()
  // Cannot use a dialog identifier, nor answer as an attributed agent.
  expect(
    await control.run(
      BRAIN_APPROVAL,
      { action: 'answer', dialogId: ask.confirmId, approved: true },
      true,
    ),
  ).toMatchObject({ status: 'denied' })
  const answer = { action: 'answer', id: ask.confirmId, approved: true }
  expect(
    await control.run(BRAIN_APPROVAL, answer, true, { actor: { kind: 'agent' } }),
  ).toMatchObject({ status: 'denied' })
  expect(await cli.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({ status: 'denied' })
  expect(await control.run(BRAIN_APPROVAL, answer, true)).toMatchObject({ status: 'ok' })
  expect(await cli.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({ status: 'ok' })
  expect(h).toHaveBeenCalledOnce()
})
