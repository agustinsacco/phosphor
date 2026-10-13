import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { parseHeartbeatRequest } from '@phosphor/shared/control-api'
import { TraceEvents } from './events'
import type { Env } from './http'

const beat = {
  seq: 1,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 0,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}
function setup() {
  let now = 0
  const log = vi.fn()
  const events = new TraceEvents(() => now, log)
  const app = new Hono<Env>()
  app.post('/:id', async (c) => {
    c.set('requestId', '0'.repeat(32))
    const input = parseHeartbeatRequest(await c.req.json())
    if (!input.ok) throw new Error('invalid fixture')
    events.accepted(c, c.req.param('id'), input.value)
    return c.body(null, 204)
  })
  app.delete('/:id', (c) => {
    events.removed(c, c.req.param('id'))
    return c.body(null, 204)
  })
  return {
    log,
    advance: (ms: number) => {
      now += ms
    },
    call: (id: string, value = beat) =>
      app.request('/' + id, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    remove: (id: string) => app.request('/' + id, { method: 'DELETE' }),
  }
}
it('logs once per process transition, at silence >90s only, and forgets removed hosts', async () => {
  const h = setup()
  await h.call('a')
  h.advance(90_000)
  await h.call('a')
  expect(h.log.mock.calls.map(([entry]) => entry.event)).toEqual(['host.connected'])
  h.advance(90_001)
  await h.call('a')
  await h.call('a', { ...beat, readiness: { ...beat.readiness, pi: 'unknown' } })
  expect(h.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: 'host.state',
      state: 'running',
      readiness: { ...beat.readiness, pi: 'unknown' },
    }),
  )
  await h.call('a', { ...beat, state: 'stopping' })
  expect(h.log.mock.calls.map(([entry]) => entry.event)).toEqual([
    'host.connected',
    'host.connected',
    'host.state',
    'host.state',
  ])
  await h.remove('a')
  await h.call('a')
  expect(h.log.mock.calls.slice(-2).map(([entry]) => entry.event)).toEqual([
    'host.removed',
    'host.connected',
  ])
})
it('holds exactly 10,000 hosts and evicts the least recently beaten at one past the cap', async () => {
  const h = setup()
  for (let n = 0; n < 10_000; n++) await h.call(String(n))
  h.log.mockClear()
  await h.call('0')
  await h.call('9999')
  expect(h.log).not.toHaveBeenCalled()
  await h.call('10000')
  await h.call('0')
  expect(h.log).toHaveBeenCalledTimes(1)
  await h.call('1')
  expect(h.log).toHaveBeenLastCalledWith(
    expect.objectContaining({ event: 'host.connected', hostId: '1' }),
  )
  expect(h.log).toHaveBeenCalledTimes(2)
})
