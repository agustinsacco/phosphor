import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Receipt, HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { openStore } from '../lanes/store'
import { createLaneCommands, type LaneCommandClient } from '../lanes/commands'
import { createTerminals } from './service'
import { createLaneAdapter } from '../api/lanes'
import { createLaneStreams, createLanesTopic } from '../lanes/stream'

it('uses fenced durable receipts, suppresses duplicate creates and rejects terminal capability loss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-wire-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const store = await openStore(join(dir, 'state'), process.getuid?.(), { now: Date.now })
  const [repository] = store.syncRepositories([repo])
  if (!repository) throw new Error('repository missing')
  const lane = store.ensureLane({ repositoryId: repository.id, cwd: repo, sessionFile: null })
  const client: LaneCommandClient = {
    id: randomUUID(),
    label: 'Controller',
    caps: ['sessions.control', 'terminal'],
  }
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
  }
  const spawn = vi.fn(() => pty)
  const terminals = createTerminals({
    native: { spawn },
    context: { store, env: {}, home: dir, log() {} },
    env: { PATH: '/usr/bin:/bin' },
    epoch: 'a'.repeat(16),
    load: () => [],
    save() {},
    shell: () => '/bin/sh',
  })
  const receipts: Receipt[] = []
  const commands = createLaneCommands({
    store,
    terminals,
    sessions: { start: vi.fn(), attach: vi.fn(), stop: vi.fn() },
    runtime: { command: vi.fn(), extensionUiResponse: vi.fn() },
    resumeLane: vi.fn(),
    stopLane: vi.fn(),
    sessionFor: () => null,
    openDialogs: () => [],
    summaryFor: () => null,
    publish() {},
    deliver: (_, receipt) => receipts.push(receipt),
    now: Date.now,
    log() {},
  })
  try {
    const frame = {
      type: 'command' as const,
      requestId: randomUUID(),
      laneId: lane.laneId,
      fence: 1,
      op: { type: 'terminal.create' as const, cols: 80, rows: 24 },
    }
    await commands.submit({ ...client, caps: ['sessions.control'] }, frame)
    expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(spawn).not.toHaveBeenCalled()
    await commands.submit(client, frame)
    expect(receipts.at(-1)?.status).toBe('done')
    await commands.submit(client, frame)
    expect(spawn).toHaveBeenCalledOnce()
    await commands.submit(client, { ...frame, requestId: randomUUID(), fence: 99 })
    expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'stale-fence' })
    expect(spawn).toHaveBeenCalledOnce()
  } finally {
    await commands.close()
    terminals.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('gates input/subscription on current caps, detaches on renewal/disconnect and shares the subscription bound', async () => {
  const input = vi.fn(() => true)
  const drop = vi.fn()
  const subscribe = vi.fn(() => drop)
  const epoch = 'a'.repeat(16)
  // Only the adapter's terminal ports are exercised here. The service guards are tested separately.
  const terminals = {
    input,
    subscribe,
    execute: vi.fn(),
    close: vi.fn(),
    feature: { capability: 'terminal' as const, methods: ['terminal.list'], call: vi.fn() },
  }
  const streams = createLaneStreams({ epoch, snapshot: () => null })
  const adapter = createLaneAdapter(
    {
      epoch,
      capabilities: ['terminal'],
      terminals,
      commands: { submit: vi.fn(), status: vi.fn() },
      calls: { call: vi.fn(), capabilityFor: () => null },
      streams,
      lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
      controllerPresence() {},
    },
    { limits: { subscriptionsPerConnection: 1 } },
  )
  const pair = createLoopbackPair()
  const frames: HostFrame[] = []
  pair.client.onMessage((text) => frames.push(JSON.parse(text)))
  const handler = adapter.handler({
    connectionId: epoch,
    client: { id: randomUUID(), label: 'Viewer' },
    caps: ['terminal', 'sessions.control'],
    socket: pair.server,
  })
  const terminalId = randomUUID()
  const sub = { type: 'subscribe' as const, topic: 'terminal' as const, id: 's', terminalId }
  const frame = { type: 'terminal.input' as const, terminalId, seq: 1, data: 'x' }
  handler.handle(sub, [])
  handler.handle({ ...sub, id: 'second' }, [])
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'too-many' })
  handler.handle(frame, [])
  expect(input).toHaveBeenCalledOnce()
  handler.renew(['terminal'])
  handler.handle(frame, [])
  expect(input).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'terminal.ack', accepted: false })
  handler.renew(['sessions.control'])
  handler.handle(frame, [])
  expect(input).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'terminal.ack', accepted: false })
  expect(drop).toHaveBeenCalledOnce()
  handler.handle(sub, [])
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'forbidden' })
  handler.close()
  expect(terminals.close).not.toHaveBeenCalled()
})
