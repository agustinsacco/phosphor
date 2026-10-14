import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { HostCapability } from '@phosphor/shared/remote-host'
import * as files from '../features/files'
import { HOST_LIMITS, type Receipt, type HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { openStore } from '../lanes/store'
import { createLaneCommands, type LaneCommandClient } from '../lanes/commands'
import { createTerminals, type HostTerminals } from './service'
import type { TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
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
  let release = () => {}
  let held = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtimeCommand = vi.fn(async () => {
    await held
    return { type: 'response' as const, command: 'prompt' as const, success: true as const }
  })
  const commands = createLaneCommands({
    store,
    terminals,
    sessions: { start: vi.fn(), attach: vi.fn(), stop: vi.fn() },
    runtime: { command: runtimeCommand, extensionUiResponse: vi.fn() },
    resumeLane: vi.fn(),
    stopLane: async () => {
      await runtimeCommand()
    },
    sessionFor: () => 'live',
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
    const execute = vi.spyOn(terminals, 'execute')
    frame.fence = store.getLane(lane.laneId)?.control.fence ?? 1
    for (const disconnect of [false, true]) {
      held = new Promise<void>((resolve) => {
        release = resolve
      })
      const epoch = 'b'.repeat(16)
      const adapter = createLaneAdapter({
        epoch,
        capabilities: client.caps,
        terminals,
        commands,
        streams: createLaneStreams({ epoch, snapshot: () => null }),
        lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
        calls: { call: vi.fn(), capabilityFor: () => null },
        controllerPresence() {},
      })
      const pair = createLoopbackPair()
      const handler = adapter.handler({
        connectionId: epoch,
        client,
        caps: client.caps,
        socket: pair.server,
      })
      const blocker = commands.submit(client, {
        ...frame,
        requestId: randomUUID(),
        op: { type: 'lane.stop' },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(runtimeCommand).toHaveBeenCalledTimes(disconnect ? 2 : 1)
      const queuedId = randomUUID()
      handler.handle({ ...frame, requestId: queuedId }, [])
      if (disconnect) handler.close()
      else handler.renew(['sessions.control'])
      release()
      await blocker
      // Draining stays ordered behind the held lane stop.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(store.getReceipt(queuedId, client.id)).toMatchObject({
        status: 'rejected',
        code: 'forbidden',
      })
      expect(spawn).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
      handler.close()
    }

    const created = receipts.find((r) => r.status === 'done' && r.data)
    if (
      !created ||
      created.status !== 'done' ||
      typeof created.data !== 'object' ||
      created.data === null ||
      !('terminalId' in created.data) ||
      typeof created.data.terminalId !== 'string'
    )
      throw new Error('missing terminal id')
    const terminalId = created.data.terminalId
    const laneRoot = files.laneRoot
    for (const lost of ['terminal', 'sessions.control'] as const) {
      for (const op of [
        frame.op,
        { type: 'terminal.resize' as const, terminalId, cols: 90, rows: 30 },
        { type: 'terminal.kill' as const, terminalId },
      ]) {
        let caps: readonly HostCapability[] = client.caps
        const spy = vi.spyOn(files, 'laneRoot').mockImplementationOnce(async (...args) => {
          const root = await laneRoot(...args)
          caps = client.caps.filter((c) => c !== lost)
          return root
        })
        try {
          await commands.submit(
            { ...client, currentCaps: () => caps },
            { ...frame, requestId: randomUUID(), op },
          )
          expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
        } finally {
          spy.mockRestore()
        }
      }
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(pty.resize).not.toHaveBeenCalled()
    expect(pty.kill).not.toHaveBeenCalled()
  } finally {
    await commands.close()
    terminals.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('gates input/subscription on current caps, detaches on renewal/disconnect and shares the subscription bound', async () => {
  const input = vi.fn(() => true)
  let output: ((frame: TerminalFrame) => void) | undefined
  const drop = vi.fn(() =>
    output?.({ type: 'terminal.output', id: 's', terminalId, epoch, seq: 1, data: 'revoked' }),
  )
  const subscribe = vi.fn<HostTerminals['subscribe']>((_frame, send) => {
    output = send
    return drop
  })
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
  expect(frames.some((f) => f.type === 'terminal.output')).toBe(false)
  handler.handle(sub, [])
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'forbidden' })
  handler.close()
  expect(terminals.close).not.toHaveBeenCalled()
})

it.each(['throw', 'overflow'] as const)(
  'detaches initial terminal delivery on socket %s',
  (failure) => {
    const epoch = 'c'.repeat(16)
    const listeners = new Set<(frame: TerminalFrame) => void>()
    const terminalId = randomUUID()
    const reset = {
      type: 'terminal.reset' as const,
      id: 's',
      terminalId,
      epoch,
      seq: 0,
      inputSeq: 0,
      status: 'running' as const,
      data: '',
    }
    const subscribe = vi.fn<HostTerminals['subscribe']>((_frame, send) => {
      listeners.add(send)
      send(reset)
      return () => {
        listeners.delete(send)
      }
    })
    const adapter = createLaneAdapter({
      epoch,
      capabilities: ['terminal'],
      terminals: {
        subscribe,
        input: vi.fn(),
        execute: vi.fn(),
        close: vi.fn(),
        feature: { capability: 'terminal', methods: [], call: vi.fn() },
      },
      commands: { submit: vi.fn(), status: vi.fn() },
      calls: { call: vi.fn(), capabilityFor: () => null },
      streams: createLaneStreams({ epoch, snapshot: () => null }),
      lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
      controllerPresence() {},
    })
    const pair = createLoopbackPair()
    const handler = adapter.handler({
      connectionId: epoch,
      client: { id: randomUUID(), label: 'Viewer' },
      caps: ['terminal'],
      socket: {
        ...pair.server,
        send: () => {
          throw new Error('send failed')
        },
        bufferedBytes: () => (failure === 'overflow' ? HOST_LIMITS.sendQueueBytes : 0),
      },
    })
    handler.handle({ type: 'subscribe', topic: 'terminal', id: 's', terminalId }, [])
    expect(subscribe).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    handler.close()
  },
)
