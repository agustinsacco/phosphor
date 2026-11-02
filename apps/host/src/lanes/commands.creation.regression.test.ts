import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import * as folders from './worktree'
import type { LaneCommandClient, LaneCommandFrame } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

// A lane.create used to hold the Host's laneless queue through git worktree add
// and pi boot, so every other machine operation waited seconds behind it.

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

const create = (overrides: Partial<Extract<LaneOp, { type: 'lane.create' }>> = {}) =>
  ({
    type: 'command',
    requestId: randomUUID(),
    op: { type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null, ...overrides },
  }) satisfies LaneCommandFrame
const folder = () =>
  vi
    .spyOn(folders, 'prepareLaneFolder')
    .mockResolvedValue({ cwd: f.lane.cwd, branch: null, undo: async () => {} })

describe('the laneless queue during a creation', () => {
  it('runs a repository op while the creation boots pi', async () => {
    folder()
    const start = deferred<{ sessionId: string; sessionFile: null }>()
    const entered = deferred<void>()
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(() => {
      entered.release()
      return start.promise
    })
    const order: string[] = []
    f.ports.repositories = {
      execute: vi.fn(async () => {
        order.push('repository')
        return { ok: true as const }
      }),
    }
    const client: LaneCommandClient = { ...f.one, caps: ['workspaces.write', 'sessions.control'] }
    const request = create()
    const creating = f.service.submit(client, request).then(() => order.push('created'))
    await entered.promise
    const repository = {
      type: 'command' as const,
      requestId: randomUUID(),
      op: { type: 'host.repositories.order' as const, repositoryIds: [f.lane.repositoryId] },
    }
    const ordering = f.service.submit(client, repository)
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['repository'])
    start.release({ sessionId: 'new-session', sessionFile: null })
    await Promise.all([creating, ordering])
    expect(order).toEqual(['repository', 'created'])
    expect(f.last(repository.requestId)?.status).toBe('done')
    expect(f.last(request.requestId)?.status).toBe('done')
  })
})
