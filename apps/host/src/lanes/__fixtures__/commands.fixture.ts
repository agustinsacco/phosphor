import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { LaneEvent, LaneOp, Receipt } from '@phosphor/shared/host-protocol'
import type { HostRuntime } from '../../session/runtime'
import { openStore, type HostStore, type StoredLane } from '../store'
import {
  createLaneCommands,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from '../commands'

export function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('not initialized')
  }
  let reject: (error: unknown) => void = () => {
    throw new Error('not initialized')
  }
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  return { promise, release, reject }
}
type PiAnswer = Awaited<ReturnType<HostRuntime['command']>>
export interface CommandsFixture {
  root: string
  store: HostStore
  lane: StoredLane
  ports: LaneCommandPorts
  service: ReturnType<typeof createLaneCommands>
  one: LaneCommandClient
  two: LaneCommandClient
  success: Extract<PiAnswer, { success: true }>
  sent: { clientId: string; receipt: Receipt }[]
  events: { laneId: string; event: LaneEvent }[]
  order: string[]
  pending: ReturnType<typeof deferred<PiAnswer>>[]
  sessions: Map<string, string>
  logs: { message: string; data: unknown }[]
  command: ReturnType<typeof vi.fn<HostRuntime['command']>>
  respond: ReturnType<typeof vi.fn<HostRuntime['extensionUiResponse']>>
  frame(op?: LaneOp, fence?: number, laneId?: string): LaneCommandFrame
  receipts(requestId: string): Receipt[]
  last(requestId: string): Receipt | undefined
  finish(index: number, value?: PiAnswer): void
  cleanup(): void
}

function commandPorts(
  store: HostStore,
  currentStore: () => HostStore,
  state: Pick<
    CommandsFixture,
    'command' | 'respond' | 'sessions' | 'events' | 'order' | 'sent' | 'logs'
  >,
): LaneCommandPorts {
  return {
    store,
    sessions: {
      start: vi.fn(async () => ({ sessionId: 'new-session', sessionFile: null })),
      attach: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    },
    runtime: { command: state.command, extensionUiResponse: state.respond },
    resumeLane: vi.fn(async (saved) => {
      state.sessions.set(saved.laneId, 'resumed')
    }),
    stopLane: vi.fn(async (id) => {
      state.sessions.delete(id)
    }),
    sessionFor: (id) => state.sessions.get(id) ?? null,
    openDialogs: () => ['dialog'],
    summaryFor: (id) => {
      const saved = currentStore().getLane(id)
      if (!saved) return null
      const { sessionFile: _sessionFile, removedAt: _removedAt, ...summary } = saved
      return { ...summary, activity: 'working' }
    },
    publish: (laneId, event) => {
      state.events.push({ laneId, event })
      state.order.push(event.kind)
    },
    deliver: (clientId, receipt) => {
      state.sent.push({ clientId, receipt })
    },
    now: () => Date.now(),
    log: (_scope, message, data) => {
      state.logs.push({ message, data })
    },
  }
}

export async function createCommandsFixture(): Promise<CommandsFixture> {
  const root = mkdtempSync(join(tmpdir(), 'host-commands-'))
  const repository = join(root, 'repo')
  mkdirSync(repository)
  const store = await openStore(join(root, 'state'), process.getuid?.(), { now: () => Date.now() })
  const entry = store.syncRepositories([repository])[0]
  if (!entry) throw new Error('missing repository')
  const lane = store.ensureLane({
    repositoryId: entry.id,
    cwd: repository,
    sessionFile: join(root, 'session.jsonl'),
  })
  const state = {
    sent: [] as CommandsFixture['sent'],
    events: [] as CommandsFixture['events'],
    order: [] as string[],
    pending: [] as CommandsFixture['pending'],
    logs: [] as CommandsFixture['logs'],
    sessions: new Map([[lane.laneId, 'pi-live']]),
    command: vi.fn<HostRuntime['command']>(),
    respond: vi.fn<HostRuntime['extensionUiResponse']>(),
  }
  const ports = commandPorts(store, () => fixture.store, state)
  const fixture: CommandsFixture = {
    root,
    store,
    lane,
    ports,
    ...state,
    service: createLaneCommands(ports),
    one: { id: randomUUID(), label: 'One', caps: ['sessions.control'] },
    two: { id: randomUUID(), label: 'Two', caps: ['sessions.control'] },
    success: { type: 'response', command: 'prompt', success: true },
    frame: (
      op = { type: 'prompt', message: 'private prompt' },
      fence = 1,
      laneId = fixture.lane.laneId,
    ) => ({ type: 'command', requestId: randomUUID(), laneId, fence, op }),
    receipts: (requestId) =>
      fixture.sent.filter((s) => s.receipt.requestId === requestId).map((s) => s.receipt),
    last: (requestId) => fixture.receipts(requestId).at(-1),
    finish: (index, value = fixture.success) => {
      const response = fixture.pending[index]
      if (!response) throw new Error('missing pi request')
      response.release(value)
    },
    cleanup: () => {
      fixture.store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  state.command.mockImplementation((_id, cmd) => {
    fixture.order.push('run')
    const currentRequest = cmd.id ?? ''
    const recorded =
      fixture.store.getReceipt(currentRequest, fixture.one.id) ??
      fixture.store.getReceipt(currentRequest, fixture.two.id)
    expect(recorded?.status).toBe('pending')
    const response = deferred<PiAnswer>()
    fixture.pending.push(response)
    return response.promise
  })
  return fixture
}
