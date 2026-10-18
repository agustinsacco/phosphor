import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandsFixture, type CommandsFixture } from './__fixtures__/commands.fixture'

let fixtures: CommandsFixture[]
beforeEach(() => {
  vi.useFakeTimers()
  fixtures = []
})
afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('commands fixture', () => {
  it('isolates two stores and deferred RPCs, and cleans up each instance independently', async () => {
    const first = await createCommandsFixture()
    fixtures.push(first)
    const second = await createCommandsFixture()
    fixtures.push(second)
    expect(first.root).not.toBe(second.root)
    expect(first.store).not.toBe(second.store)
    expect(first.ports).not.toBe(second.ports)
    expect(first.service).not.toBe(second.service)
    expect(first.one.id).not.toBe(second.one.id)
    expect(first.two.id).not.toBe(second.two.id)
    expect(first.success).not.toBe(second.success)
    expect(first.store.getLane(second.lane.laneId)).toBeNull()
    expect(second.store.getLane(first.lane.laneId)).toBeNull()

    const firstRequest = first.frame()
    const secondRequest = second.frame()
    const firstRun = first.service.submit(first.one, firstRequest)
    expect(first.pending).toHaveLength(1)
    expect(second.pending).toEqual([])
    expect(second.command).not.toHaveBeenCalled()
    expect(second.events).toEqual([])
    expect(second.order).toEqual([])
    expect(second.sent).toEqual([])
    expect(second.logs).toEqual([])
    first.sessions.clear()
    expect(second.sessions.get(second.lane.laneId)).toBe('pi-live')
    first.respond('pi-live', { type: 'extension_ui_response', id: 'dialog', confirmed: true })
    expect(second.respond).not.toHaveBeenCalled()

    const secondRun = second.service.submit(second.one, secondRequest)
    expect(first.pending[0]).not.toBe(second.pending[0])
    expect(second.store.getReceipt(firstRequest.requestId, first.one.id)).toBeNull()
    first.finish(0)
    await firstRun
    expect(first.last(firstRequest.requestId)?.status).toBe('done')
    expect(second.last(secondRequest.requestId)).toBeUndefined()
    expect(second.store.getReceipt(secondRequest.requestId, second.one.id)?.status).toBe('pending')

    first.cleanup()
    fixtures.shift()
    expect(existsSync(first.root)).toBe(false)
    expect(existsSync(second.root)).toBe(true)
    second.finish(0)
    await secondRun
    expect(second.last(secondRequest.requestId)?.status).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
    second.cleanup()
    fixtures.shift()
    expect(existsSync(second.root)).toBe(false)
  })
})
