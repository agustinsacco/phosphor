import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OpReplyEnvelope, OpRequestEnvelope } from '@phosphor/shared/ops'
import type { LiveSession } from '../session-registry'
import type { OpChannelRequestEvent } from '../op-channel'
import { bindOpChannel, createOpsSpawnContribution } from './ops'

const request: OpRequestEnvelope = { v: 1, id: 'op-1', argv: ['help'], deadlineMs: 30_000 }
const ok: OpReplyEnvelope = { v: 1, id: 'op-1', status: 'ok', text: 'done', applies: 'now' }

function session() {
  const client = new EventEmitter()
  const live = { sessionId: 'lane-1', workspacePath: '/w', client } as unknown as LiveSession
  const replies: OpReplyEnvelope[] = []
  const send = () =>
    new Promise<OpReplyEnvelope>((resolve) => {
      const event: OpChannelRequestEvent = {
        request,
        respond: (reply) => {
          replies.push(reply)
          resolve(reply)
        },
      }
      client.emit('phosphor-op', event)
    })
  return { client, live, replies, send }
}

describe('createOpsSpawnContribution', () => {
  const ports = (agentControl: boolean) => ({
    resourceRoot: () => '/resources',
    agentControl: () => agentControl,
    dispatcher: () => null,
  })

  it('adds the marker, the phosphor tool and its skill', async () => {
    const contribution = createOpsSpawnContribution(ports(true))
    expect(contribution.name).toBe('ops')
    await expect(contribution.spawn({}, { options: {} as never })).resolves.toEqual({
      env: { PHOSPHOR_OPS: 'v1' },
      extensions: ['/resources/pi-ext/phosphor.ts'],
      skills: ['/resources/skills/phosphor'],
    })
  })

  it('keeps only the marker when agent control is off, for Brain', async () => {
    const contribution = createOpsSpawnContribution(ports(false))
    await expect(contribution.spawn({}, { options: {} as never })).resolves.toEqual({
      env: { PHOSPHOR_OPS: 'v1' },
    })
  })
})

describe('bindOpChannel', () => {
  it('answers with the dispatcher reply for this session', async () => {
    const { live, send } = session()
    const runFromTool = vi.fn(async () => ok)
    bindOpChannel(live, { dispatcher: () => ({ runFromTool, cancelLane: vi.fn() }) }, vi.fn())
    await expect(send()).resolves.toBe(ok)
    expect(runFromTool).toHaveBeenCalledExactlyOnceWith('lane-1', request)
  })

  it('answers no-owner while no dispatcher is bound', async () => {
    const { live, send } = session()
    bindOpChannel(live, { dispatcher: () => null }, vi.fn())
    await expect(send()).resolves.toEqual({
      v: 1,
      id: 'op-1',
      status: 'unsupported',
      code: 'no-owner',
    })
  })

  it('answers unavailable and logs when the dispatcher rejects', async () => {
    const { live, send } = session()
    const log = vi.fn()
    const runFromTool = vi.fn(async () => {
      throw new Error('store closed')
    })
    bindOpChannel(live, { dispatcher: () => ({ runFromTool, cancelLane: vi.fn() }) }, log)
    await expect(send()).resolves.toMatchObject({ status: 'error', code: 'unavailable' })
    expect(log).toHaveBeenCalledWith('pi', 'op failed', expect.any(Object))
  })

  it('cancels the lane on Stop and on exit, and forwards liveness', () => {
    const { client, live } = session()
    const cancelLane = vi.fn()
    const liveness = vi.fn()
    bindOpChannel(
      live,
      { dispatcher: () => ({ runFromTool: vi.fn(), cancelLane }), liveness },
      vi.fn(),
    )
    client.emit('phosphor-op-stop')
    client.emit('exit', { code: 0, signal: null, expected: true })
    client.emit('lane-liveness', 2)
    expect(cancelLane.mock.calls).toEqual([['lane-1'], ['lane-1']])
    expect(liveness).toHaveBeenCalledExactlyOnceWith('lane-1', 2)
  })
})
