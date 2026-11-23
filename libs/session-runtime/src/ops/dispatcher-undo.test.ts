import { expect, it } from 'vitest'
import { createHarness, agent, surface } from './__fixtures__/dispatcher-harness'
import type { OpsDispatcher } from './types'

it('redeems an audited op without holding the control queue its inverse must use', async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const order: string[] = []
  let dispatcher: OpsDispatcher
  const h = createHarness({
    handlers: {
      'audit.undo': async ({ auditId }, { principal }) => {
        const reply = await dispatcher.undo(principal, String(auditId))
        return { text: reply.text }
      },
      'swarm.off': async () => {
        order.push('inverse')
        started.resolve()
        await finish.promise
        order.push('inverse done')
        return { text: 'Off.' }
      },
      notify: async () => {
        order.push('ordinary')
        return { text: 'Done.' }
      },
    },
  })
  dispatcher = h.dispatcher
  const on = await h.run(agent(), { op: 'swarm.on', args: {}, reason: 'delegate' })
  if (on.status !== 'ok' || !on.auditId) throw new Error('Expected audited op')
  const undo = h.run(surface(), { op: 'audit.undo', args: { auditId: on.auditId } })
  await started.promise
  const ordinary = h.run(surface(), { op: 'notify', args: { text: 'done' } })
  finish.resolve()
  expect((await undo).status).toBe('ok')
  await ordinary
  expect(order).toEqual(['inverse', 'inverse done', 'ordinary'])
}, 2000)
