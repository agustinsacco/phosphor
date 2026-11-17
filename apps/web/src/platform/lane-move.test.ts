import { afterEach, expect, it, vi } from 'vitest'
import type * as LaneMove from '@phosphor/host-client/lane-move'
import type { LaneMoveRequest } from '@phosphor/shared/lane-move'
import { createBrowserHandlers } from './handlers'
import { createBrowserApi } from './index'

/* "Move to…" in the browser: Host-to-Host requests reach the shared relay; nothing else does. */

const moves = vi.hoisted(() => ({
  plan: vi.fn(async () => ({
    mode: 'folder',
    branch: null,
    workspace: 'notes',
    blockers: [],
    bytes: 1,
  })),
  move: vi.fn(async () => ({ machine: 'b', laneId: '66666666-7777-4888-9999-000000000000' })),
  abort: vi.fn(),
}))
vi.mock('@phosphor/host-client/lane-move', async (importOriginal) => ({
  ...(await importOriginal<typeof LaneMove>()),
  createHostLaneMoves: () => moves,
}))
afterEach(() => vi.clearAllMocks())

const laneId = '11111111-2222-4333-8444-555555555555'
const hostToHost: LaneMoveRequest = {
  source: { machine: 'a', laneId },
  target: { machine: 'b', repositoryId: 'a'.repeat(16) },
  marks: { pinned: true, marker: null },
}

function handlers() {
  const proxy = new Proxy({}, { get: () => () => undefined })
  return createBrowserHandlers({
    ...{ control: proxy, hosts: proxy, resources: proxy, prefs: proxy, drafts: proxy },
    lanes: proxy,
    laneMoves: moves,
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never)
}

it('plans and moves a Host lane to another Host through the shared relay', async () => {
  const h = handlers()
  expect(await h['hosts:laneMovePlan'](hostToHost)).toMatchObject({ bytes: 1 })
  expect(await h['hosts:laneMove'](hostToHost)).toEqual({
    machine: 'b',
    laneId: '66666666-7777-4888-9999-000000000000',
  })
  expect(moves.plan).toHaveBeenCalledWith(hostToHost)
  expect(moves.move).toHaveBeenCalledWith(hostToHost)
})

it('refuses This Mac on either end and malformed requests before any Host call', () => {
  const h = handlers()
  const local = [
    { ...hostToHost, source: { machine: 'local', sessionPath: '/s.jsonl' } },
    { ...hostToHost, target: { machine: 'local', workspace: '/work' } },
    { ...hostToHost, source: { machine: 'a', laneId: '../x' } },
    { ...hostToHost, marks: { pinned: 'yes', marker: null } },
    null,
  ]
  for (const request of local) {
    expect(() => h['hosts:laneMovePlan'](request as never)).toThrow('This lane cannot move.')
    expect(() => h['hosts:laneMove'](request as never)).toThrow('This lane cannot move.')
  }
  expect(moves.plan).not.toHaveBeenCalled()
  expect(moves.move).not.toHaveBeenCalled()
})

it('aborts a running move when another owner signs in and when the page goes away', async () => {
  let invalidate!: () => void
  const adapter = createBrowserApi({
    fetch: vi.fn<typeof fetch>(async () => new Response('', { status: 401 })),
    storage: null,
    lifecycle: { subscribe: () => () => {} },
    invalidation: {
      subscribe: (cb) => {
        invalidate = cb
        return () => {}
      },
      close: () => {},
      publish: () => {},
    },
  })
  await adapter.start()
  // Starting signed out already clears the previous owner's state, a move included.
  moves.abort.mockClear()
  invalidate()
  expect(moves.abort).toHaveBeenCalledOnce()
  // Disposing invalidates the account, which aborts again.
  adapter.dispose()
  expect(moves.abort).toHaveBeenCalledTimes(2)
})
