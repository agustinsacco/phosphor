import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { createLaneCommands, type LaneCommandFrame } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

let f: CommandsFixture
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('lane commands connection routing and close', () => {
  it('routes attempt replies to one connection and execution terminals client-wide', async () => {
    const deliver = vi.fn()
    f.service = createLaneCommands({ ...f.ports, deliver })
    const client = { ...f.one, connectionId: 'connection-one' }
    const request = f.frame()
    const running = f.service.submit(client, request)
    await f.service.submit(client, request)
    expect(deliver).toHaveBeenLastCalledWith(
      f.one.id,
      expect.objectContaining({ status: 'pending' }),
      client.connectionId,
    )
    await f.service.submit(client, { ...request, op: { type: 'abort' } })
    expect(deliver).toHaveBeenLastCalledWith(
      f.one.id,
      expect.objectContaining({ code: 'conflict' }),
      client.connectionId,
    )
    f.service.status(f.one.id, request.requestId, 'connection-two')
    expect(deliver).toHaveBeenLastCalledWith(
      f.one.id,
      expect.objectContaining({ status: 'pending' }),
      'connection-two',
    )
    f.finish(0)
    await running
    expect(deliver).toHaveBeenLastCalledWith(
      f.one.id,
      expect.objectContaining({ status: 'done', fence: 2 }),
      undefined,
    )
    await f.service.submit(client, request)
    expect(deliver).toHaveBeenLastCalledWith(
      f.one.id,
      expect.objectContaining({ status: 'done' }),
      client.connectionId,
    )
  })
  it('bounds close, refuses new work, and ignores a late RPC after store closure', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    const close = f.service.close()
    await f.service.submit(f.one, f.frame())
    expect(f.command).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    await close
    expect(f.service.close()).toBe(close)
    const finishRequest = vi.spyOn(f.store, 'finishRequest')
    const publish = vi.spyOn(f.ports, 'publish')
    f.finish(0)
    await running
    expect(finishRequest).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(f.last(request.requestId)).toBeUndefined()
  })
  it('a late creation cannot ensure or mark a lane after close', async () => {
    const start = deferred<{ sessionId: string; sessionFile: string | null }>()
    f.ports.sessions.start = () => start.promise
    const repository = f.store.listRepositories()[0]
    if (!repository) throw new Error('fixture')
    const request: LaneCommandFrame = {
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'lane.create', repositoryId: repository.id, worktree: null },
    }
    const running = f.service.submit(f.one, request)
    await vi.advanceTimersByTimeAsync(0)
    const close = f.service.close()
    await vi.advanceTimersByTimeAsync(2000)
    await close
    const ensure = vi.spyOn(f.store, 'ensureLane')
    const removed = vi.spyOn(f.store, 'markRemoved')
    start.release({ sessionId: 'late', sessionFile: null })
    await running
    expect(ensure).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    expect(f.ports.sessions.attach).not.toHaveBeenCalled()
    expect(f.ports.sessions.stop).toHaveBeenCalledWith('late')
  })
})

it('close waits for an outstanding operation even after its receipt deadline', async () => {
  const running = f.service.submit(f.one, f.frame())
  await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
  await running
  let closed = false
  const close = f.service.close().then(() => {
    closed = true
  })
  await vi.advanceTimersByTimeAsync(1999)
  expect(closed).toBe(false)
  f.finish(0)
  await close
  expect(closed).toBe(true)
})

it('a late dialog answer cannot publish after close', async () => {
  const answer = deferred<void>()
  f.respond.mockImplementation(() => answer.promise)
  const request = f.frame({
    type: 'extension_ui_response',
    response: { type: 'extension_ui_response', id: 'dialog', value: 'answer' },
  })
  const running = f.service.submit(f.one, request)
  const close = f.service.close()
  await vi.advanceTimersByTimeAsync(2000)
  await close
  const publish = vi.spyOn(f.ports, 'publish')
  answer.release()
  await running
  expect(publish).not.toHaveBeenCalled()
})
