import { EventEmitter, once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { loadSqlite } from '../sqlite'
import { createHarness, agent, surface } from './__fixtures__/dispatcher-harness'
import { AGENT_OPS_SCHEMA, createAuditLog } from './audit'
import { createOpsDispatcher } from './dispatcher'
import { createUndo } from './undo'
import type { OpsDispatcher } from './types'

it('redeems an audited op without holding the control queue its inverse must use', async () => {
  const db = new (loadSqlite().DatabaseSync)(':memory:')
  try {
    db.exec(AGENT_OPS_SCHEMA)
    const events = new EventEmitter()
    const started = once(events, 'started')
    const order: string[] = []
    const h = createHarness({
      handlers: {
        'audit.undo': async (args, { principal }) => {
          const result = await dispatcher.undo(principal, (args as { auditId: string }).auditId)
          if (result.status !== 'ok') throw Error('Undo refused')
          return { text: result.text }
        },
        'swarm.off': async () => {
          order.push('inverse')
          events.emit('started')
          await once(events, 'release')
          order.push('inverse done')
          return { text: 'Off.' }
        },
        notify: async () => {
          order.push('ordinary')
          return { text: 'Done.' }
        },
      },
    })
    const audit = createAuditLog(db, { now: () => h.clock.now })
    const undo = createUndo({
      audit,
      isCurrent: async () => true,
      run: (p, r) => dispatcher.run(p, r),
    })
    const dispatcher: OpsDispatcher = createOpsDispatcher(
      { ...h.binding, audit },
      { ...h.deps, undo: { run: undo } },
    )
    const on = await dispatcher.run(agent(), { op: 'swarm.on', args: {}, reason: 'delegate' })
    if (on.status !== 'ok' || !on.auditId) throw new Error('Expected audited op')
    expect(audit.get(on.auditId)?.undo).toBe(true)
    const inverse = dispatcher.run(surface(), { op: 'audit.undo', args: { auditId: on.auditId } })
    await started
    const ordinary = dispatcher.run(surface(), { op: 'notify', args: { text: 'done' } })
    await setImmediate()
    expect(order).toEqual(['inverse'])
    events.emit('release')
    expect((await inverse).status).toBe('ok')
    await ordinary
    expect(order).toEqual(['inverse', 'inverse done', 'ordinary'])
    expect(audit.get(on.auditId)?.undoneBy).toBeTruthy()
  } finally {
    db.close()
  }
}, 2000)
