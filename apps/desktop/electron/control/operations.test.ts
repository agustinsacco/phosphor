import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { CONTROL_ROUTES, machineRoute, type Parsed } from '@shared/control-api'
import type { ControlResult } from '@shared/ipc'
import { createControlOperations } from './operations'
import { controlFailure } from './transport'
import {
  LOOKUP,
  MACHINE,
} from '../../../../libs/client-ui/src/features/machines/__fixtures__/control'

function harness() {
  let now = Date.parse(LOOKUP.expiresAt) - 1000
  let reply: unknown = {}
  const requests = vi.fn()
  const log = vi.fn()
  const syncGeneration = vi.fn()
  const operations = createControlOperations({
    async call<T extends object>(
      path: string,
      method: string,
      parse: (value: unknown) => Parsed<T>,
      body?: unknown,
      trace?: string,
    ): Promise<ControlResult<T>> {
      requests(path, method, body, trace)
      const parsed = parse(reply)
      return parsed.ok ? { ok: true, ...parsed.value } : controlFailure('internal')
    },
    syncGeneration,
    log,
    now: () => now,
  })
  return {
    operations,
    requests,
    log,
    syncGeneration,
    reply: (value: unknown) => {
      reply = value
    },
    advance: (ms: number) => {
      now += ms
    },
    trace: () => requests.mock.calls.at(-1)?.[3],
  }
}

describe('createControlOperations', () => {
  it('validates renderer input before calling account admission', async () => {
    const h = harness()
    const results = await Promise.all([
      h.operations.registerClient('\n'),
      h.operations.grant('bad', MACHINE.id),
      h.operations.lookupEnrollment('wrong'),
      h.operations.approveEnrollment('BCDFGHJK', ''),
      h.operations.renameMachine('../escape', 'bee'),
      h.operations.removeMachine('bad'),
    ])
    expect(results).toEqual(results.map(() => controlFailure('bad-request')))
    expect(h.requests).not.toHaveBeenCalled()
    expect(h.syncGeneration).toHaveBeenCalledOnce()
  })

  it('normalizes enrollment payloads and strips unknown response fields', async () => {
    const h = harness()
    h.reply({ ...LOOKUP, unknown: 'discard' })
    expect(await h.operations.lookupEnrollment('bcdf ghjk')).toEqual({ ok: true, ...LOOKUP })
    const trace = h.trace()
    expect(h.requests).toHaveBeenLastCalledWith(
      CONTROL_ROUTES.enrollmentLookup,
      'POST',
      { userCode: 'BCDFGHJK' },
      trace,
    )
    h.reply({ machine: { ...MACHINE, unknown: 'discard' }, unknown: 'discard' })
    expect(await h.operations.approveEnrollment('bcdf-ghjk', ' bee1 ')).toEqual({
      ok: true,
      machine: MACHINE,
    })
    expect(h.requests).toHaveBeenLastCalledWith(
      CONTROL_ROUTES.enrollmentApprove,
      'POST',
      { userCode: 'BCDFGHJK', label: 'bee1' },
      trace,
    )
    expect(h.syncGeneration).toHaveBeenCalledOnce()
    expect(h.log).toHaveBeenLastCalledWith('control', 'enrollment.approved', {
      trace,
      result: 'approved',
      hostId: MACHINE.id,
      hostname: MACHINE.hostname,
      keyFingerprint: MACHINE.keyFingerprint,
    })
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('BCDFGHJK')
  })

  it('consumes enrollment traces once and clears them explicitly or on a failed lookup', async () => {
    const h = harness()
    h.reply(LOOKUP)
    await h.operations.lookupEnrollment('BCDFGHJK')
    const first = h.trace()
    h.reply({ machine: MACHINE })
    await h.operations.approveEnrollment('BCDFGHJK', 'bee1')
    expect(h.trace()).toBe(first)
    await h.operations.approveEnrollment('BCDFGHJK', 'bee1')
    expect(h.trace()).not.toBe(first)
    h.reply(LOOKUP)
    await h.operations.lookupEnrollment('BCDFGHJK')
    const cleared = h.trace()
    h.operations.clearObservations()
    h.reply({ machine: MACHINE })
    await h.operations.approveEnrollment('BCDFGHJK', 'bee1')
    expect(h.trace()).not.toBe(cleared)
    h.reply(LOOKUP)
    await h.operations.lookupEnrollment('BCDFGHJK')
    const failed = h.trace()
    await h.operations.lookupEnrollment('bad')
    h.reply({ machine: MACHINE })
    await h.operations.approveEnrollment('BCDFGHJK', 'bee1')
    expect(h.trace()).not.toBe(failed)
  })

  it('expires pending enrollment traces at the peer deadline or fifteen-minute cap', async () => {
    for (const duration of [1000, 60 * 60_000]) {
      const h = harness()
      h.reply({
        ...LOOKUP,
        expiresAt: new Date(Date.parse(LOOKUP.expiresAt) - 1000 + duration).toISOString(),
      })
      await h.operations.lookupEnrollment('BCDFGHJK')
      const trace = h.trace()
      h.advance(Math.min(duration, 15 * 60_000))
      h.reply({ machine: MACHINE })
      await h.operations.approveEnrollment('BCDFGHJK', 'bee1')
      expect(h.trace()).not.toBe(trace)
    }
  })

  it('observes machines only on successful refresh and resets observations without resetting calls', async () => {
    const h = harness()
    const reply = { machines: [MACHINE], serverTime: '2026-01-01T00:00:00.000Z' }
    h.reply(reply)
    expect(await h.operations.machines()).toEqual({ ok: true, ...reply })
    const trace = h.trace()
    expect(h.log).toHaveBeenCalledWith(
      'machines',
      'observed',
      expect.objectContaining({ hostId: MACHINE.id, trace }),
    )
    await h.operations.machines()
    expect(h.log).toHaveBeenCalledOnce()
    h.reply({})
    expect(await h.operations.machines()).toEqual(controlFailure('internal'))
    expect(h.log).toHaveBeenCalledOnce()
    h.operations.clearObservations()
    h.reply(reply)
    await h.operations.machines()
    expect(h.log).toHaveBeenCalledTimes(2)
    expect(h.requests).toHaveBeenCalledTimes(4)
  })

  it('registers clients and issues grants with endpoint-specific response parsers', async () => {
    const h = harness()
    const client = { id: MACHINE.id, label: 'Viewer' }
    h.reply({ client: { ...client, unknown: 'discard' } })
    expect(await h.operations.registerClient(' Viewer ')).toEqual({ ok: true, client })
    expect(h.requests).toHaveBeenLastCalledWith(
      CONTROL_ROUTES.clients,
      'POST',
      { label: 'Viewer' },
      undefined,
    )
    const reply = {
      grant: `phosphor-grant.v1.${randomBytes(32).toString('base64url')}.${randomBytes(64).toString('base64url')}`,
      expiresAt: LOOKUP.expiresAt,
      host: {
        id: MACHINE.id,
        endpoint: 'https://host.ts.net',
        publicKey: randomBytes(32).toString('base64url'),
      },
    }
    h.reply(reply)
    expect(await h.operations.grant(MACHINE.id, client.id)).toEqual({ ok: true, ...reply })
    expect(h.requests).toHaveBeenLastCalledWith(
      CONTROL_ROUTES.grants,
      'POST',
      { hostId: MACHINE.id, clientId: client.id },
      undefined,
    )
    h.reply({ ...reply, host: { ...reply.host, publicKey: 'bad' } })
    expect(await h.operations.grant(MACHINE.id, client.id)).toEqual(controlFailure('internal'))
    h.reply({ client: {} })
    expect(await h.operations.registerClient('Viewer')).toEqual(controlFailure('internal'))
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(reply.grant)
  })

  it('uses the validated machine route for rename and parses removal as an empty body', async () => {
    const h = harness()
    h.reply({ machine: MACHINE })
    expect(await h.operations.renameMachine(MACHINE.id, ' bee1 ')).toEqual({
      ok: true,
      machine: MACHINE,
    })
    expect(h.requests).toHaveBeenLastCalledWith(
      machineRoute(MACHINE.id),
      'PATCH',
      { label: 'bee1' },
      undefined,
    )
    h.reply(null)
    expect(await h.operations.removeMachine(MACHINE.id)).toEqual({ ok: true })
    expect(h.requests).toHaveBeenLastCalledWith(
      machineRoute(MACHINE.id),
      'DELETE',
      undefined,
      undefined,
    )
    h.reply({})
    expect(await h.operations.removeMachine(MACHINE.id)).toEqual(controlFailure('internal'))
    expect(await h.operations.renameMachine(MACHINE.id, 'bee1')).toEqual(controlFailure('internal'))
  })
})
