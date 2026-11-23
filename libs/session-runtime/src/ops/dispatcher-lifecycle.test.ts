import { describe, expect, it } from 'vitest'
import { agent, createHarness, OTHER, OWN, surface } from './__fixtures__/dispatcher-harness'
import { OpRefusal } from './dispatcher'
import type { OpHandler, OpHandlerResult } from './types'

function gate() {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

describe('long ops', () => {
  it('starts a job and answers at once with its id', async () => {
    const h = createHarness({ jobs: true })
    const result = await h.run(surface(), { op: 'archive.purge', args: { ids: ['a1'] } })
    expect(result).toMatchObject({
      status: 'ok',
      text: 'Started: Permanently purge the selected archives. Check it with: phosphor job status job-1',
      data: { jobId: 'job-1' },
    })
    expect(h.calls.handled).toEqual([])
    const job = h.calls.jobs[0]
    if (!job) throw new Error('expected a job')
    expect(job).toMatchObject({ creator: 'surface:c1', op: 'archive.purge' })
    await job.run(new AbortController().signal)
    expect(h.calls.handled.map((c) => c.op)).toEqual(['archive.purge'])
  })

  it('runs a job op inline when the owner has no job port', async () => {
    const h = createHarness()
    expect(await h.run(surface(), { op: 'archive.purge', args: { all: true } })).toMatchObject({
      text: 'archive.purge done',
    })
  })
})

describe('queues', () => {
  it('runs one principal’s ops in order, with Brain on its own queue', async () => {
    const slow = gate()
    const order: string[] = []
    const h = createHarness({
      handlers: {
        'archive.list': async () => {
          order.push('list:start')
          await slow.opened
          order.push('list:end')
          return { text: 'listed' }
        },
        'settings.read': async () => {
          order.push('settings')
          return { text: 'read' }
        },
        'brain.search': async () => {
          order.push('brain')
          return { text: 'found' }
        },
      },
    })
    const first = h.tool({ op: 'archive.list' })
    const second = h.tool({ op: 'settings.read' })
    const brain = h.tool({ op: 'brain.search', args: { query: 'q' } })
    expect((await brain).status).toBe('ok')
    expect(order).toEqual(['list:start', 'brain'])
    slow.open()
    await Promise.all([first, second])
    expect(order).toEqual(['list:start', 'brain', 'list:end', 'settings'])
  })

  it('keeps going after a failed op', async () => {
    const h = createHarness({
      handlers: {
        'archive.list': async () => {
          throw new Error('disk gone')
        },
      },
    })
    expect(await h.run(agent(), { op: 'archive.list', args: {} })).toEqual({
      status: 'denied',
      code: 'unavailable',
      text: 'archive.list failed: disk gone',
    })
    expect((await h.run(agent(), { op: 'settings.read', args: {} })).status).toBe('ok')
  })
})

describe('in-band answers', () => {
  it('answers unknown ops, bad args, gaps and missing flags without throwing', async () => {
    const h = createHarness({
      gaps: { 'git.diff': 'git.diff is not available through the Phosphor service.' },
      flags: [],
    })
    const run = (op: string, args = {}) => h.run(surface(), { op, args })
    expect(await run('nope.op')).toMatchObject({ status: 'denied', code: 'unsupported' })
    expect(await run('lane.read', { ref: 1 })).toMatchObject({ code: 'bad-request' })
    expect(await run('git.diff', { target: '/w' })).toEqual({
      status: 'denied',
      code: 'unsupported',
      text: 'git.diff is not available through the Phosphor service.',
    })
    expect(await run('lane.tree', { ref: OTHER })).toMatchObject({ code: 'unsupported' })
  })

  it('lets the never tier win over a gap', async () => {
    const h = createHarness({ gaps: { 'brain.reset': 'gap' } })
    expect(await h.run(agent(), { op: 'brain.reset', args: {} })).toMatchObject({ code: 'never' })
  })

  it('turns a handler’s OpRefusal into a denial', async () => {
    const h = createHarness({
      handlers: {
        'lane.rename': async () => {
          throw new OpRefusal('busy', 'Renaming is in progress.')
        },
      },
    })
    expect(await h.tool({ op: 'lane.rename', args: { name: 'n' } })).toMatchObject({
      status: 'denied',
      code: 'busy',
      text: 'Renaming is in progress.',
    })
  })

  it('answers an unknown session and an argv the parser refuses', async () => {
    const h = createHarness()
    expect(await h.tool({ op: 'archive.list' }, {}, 'unknown')).toMatchObject({
      code: 'unavailable',
    })
    expect(await h.tool({ op: 'x' }, { argv: ['bad'] })).toMatchObject({
      status: 'denied',
      code: 'bad-request',
      text: 'Unknown flag --x. Did you mean --ref?',
    })
  })

  it('serves policy.show and audits agent ops but not surface ones', async () => {
    const h = createHarness({ policy: { agentControl: 'read' } })
    const shown = await h.run(agent(), { op: 'policy.show', args: {} })
    expect(shown).toMatchObject({ status: 'ok', data: { changedOutside: false } })
    expect(shown.status === 'ok' && shown.text).toContain('Agent control: read.')
    await h.run(surface(), { op: 'archive.list', args: {} })
    expect(h.calls.audit.map((r) => [r.principal, r.op, r.decision])).toEqual([
      [`agent:${OWN}`, 'policy.show', 'allowed'],
    ])
    expect(h.calls.notified).toEqual([{ kind: 'audit', laneRef: OWN }])
  })
})

describe('tool replies', () => {
  it('carries effects, a toast, untrusted framing, the audit id and Undo', async () => {
    const h = createHarness({
      handlers: {
        'lane.rename': async () => ({ text: 'Renamed.', before: { name: 'old', ref: OWN } }),
      },
    })
    const renamed = await h.tool({ op: 'lane.rename', args: { name: 'new' } })
    expect(renamed).toEqual({
      v: 1,
      id: 'r1',
      status: 'ok',
      text: 'Renamed.',
      applies: 'now',
      effects: [{ kind: 'notify', message: 'Agent ran lane.rename: Renamed.', level: 'info' }],
      auditId: 'audit-1',
    })
    expect(h.calls.undoRecords).toEqual([
      { auditId: 'audit-1', inverse: { op: 'lane.rename', args: { name: 'old', ref: OWN } } },
    ])
    const read = await h.tool({ op: 'lane.read', args: { ref: OTHER } })
    expect(read).toMatchObject({ status: 'ok', untrusted: true })
    expect(read.status === 'ok' && read.effects).toBeFalsy()
  })

  it('keeps the handler’s own Swarm toast instead of adding one', async () => {
    const h = createHarness({
      handlers: {
        'swarm.on': async () => ({
          text: 'Swarm on.',
          effects: [{ kind: 'swarm', enabled: true, reason: 'big task' }],
        }),
      },
    })
    expect(await h.tool({ op: 'swarm.on' })).toMatchObject({
      effects: [{ kind: 'swarm', enabled: true, reason: 'big task' }],
      applies: 'next-request',
    })
  })

  it('answers timeout at the deadline and aborts the handler', async () => {
    let signal: AbortSignal | undefined
    const h = createHarness({
      handlers: {
        'archive.list': (_args, ctx) => {
          signal = ctx.signal
          return new Promise<OpHandlerResult>(() => undefined)
        },
      },
    })
    expect(await h.tool({ op: 'archive.list' }, { deadlineMs: 20 })).toMatchObject({
      status: 'error',
      code: 'timeout',
    })
    expect(signal?.aborted).toBe(true)
  })

  it('answers aborted on Stop, drops queued ops and voids the lane’s confirmations', async () => {
    const started = gate()
    const ran: string[] = []
    const hang: OpHandler = async () => {
      ran.push('first')
      started.open()
      return new Promise<OpHandlerResult>(() => undefined)
    }
    const h = createHarness({
      handlers: {
        'archive.list': hang,
        'settings.read': async () => {
          ran.push('second')
          return { text: 'x' }
        },
      },
    })
    const first = h.tool({ op: 'archive.list' })
    const second = h.tool({ op: 'settings.read' })
    await started.opened
    h.dispatcher.cancelLane('s1')
    expect(await first).toMatchObject({ status: 'error', code: 'aborted' })
    expect(await second).toMatchObject({ status: 'error', code: 'aborted' })
    expect(ran).toEqual(['first'])
    expect(h.calls.voided).toEqual(['s1'])
  })
})

describe('deferred work and reload', () => {
  it('holds the lane’s own after-run work until it settles, in order, once', async () => {
    const h = createHarness({
      handlers: {
        'model.set': async () => ({
          text: 'Model after this run.',
          deferred: [{ kind: 'model', provider: 'p', modelId: 'm' }],
        }),
        'lane.compact': async () => ({ text: 'Compacting.', deferred: [{ kind: 'compact' }] }),
      },
    })
    await h.tool({ op: 'lane.compact' })
    await h.tool({ op: 'model.set', args: { model: 'p/m' } })
    expect(h.calls.applied).toEqual([])
    await h.dispatcher.settled('s1', {})
    await h.dispatcher.settled('s1', {})
    expect(h.calls.applied).toEqual([
      {
        sessionId: 's1',
        items: [{ kind: 'model', provider: 'p', modelId: 'm' }, { kind: 'compact' }],
      },
    ])
  })

  it('applies another idle lane’s deferred work at once', async () => {
    const h = createHarness({
      handlers: { 'lane.stop': async () => ({ text: 'Stopping.', deferred: [{ kind: 'stop' }] }) },
    })
    await h.run(surface(), { op: 'lane.stop', args: { ref: OTHER } })
    expect(h.calls.applied).toEqual([{ sessionId: 's2', items: [{ kind: 'stop' }] }])
  })

  it('ends the run on one self reload per user prompt', async () => {
    const h = createHarness()
    const reload = { op: 'lane.reload' }
    const first = await h.tool(reload)
    expect(first).toMatchObject({ status: 'ok', terminate: true, applies: 'reload' })
    const again = await h.tool(reload)
    expect(again.status === 'ok' && again.terminate).toBeFalsy()
    expect(again.status === 'ok' && again.text).toContain('already reloaded')
    await h.dispatcher.settled('s1', { terminatedBy: 'phosphor' })
    expect(h.calls.applied).toEqual([
      { sessionId: 's1', items: [{ kind: 'reload', what: 'lane.reload done' }] },
    ])
    h.dispatcher.userPrompted('s1')
    expect(await h.tool(reload)).toMatchObject({ terminate: true })
  })

  it('never reloads under live sub-agent work', async () => {
    const h = createHarness()
    const reply = await h.tool({ op: 'lane.reload' }, { facts: { subagentsLive: true } })
    expect(reply.status === 'ok' && reply.terminate).toBeFalsy()
    expect(reply.status === 'ok' && reply.text).toContain('sub-agent work is live')
    await h.dispatcher.settled('s1', {})
    expect(h.calls.applied).toEqual([])
  })
})

describe('undo', () => {
  it('is surface-only and delegates to the undo port', async () => {
    const h = createHarness()
    expect(await h.dispatcher.undo(agent(), 'audit-1')).toMatchObject({ code: 'forbidden' })
    expect(await h.dispatcher.undo(surface(), 'audit-1')).toMatchObject({ status: 'ok' })
    expect(h.calls.handled.map((c) => c.op)).toEqual(['swarm.off'])
  })
})
