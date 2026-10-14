import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import { helloProofMessage, HOST_LIMITS, type HostFrame } from '@phosphor/shared/host-protocol'
import {
  createLoopbackPair,
  defineHostConformance,
  type HostConformanceFactory,
} from '@phosphor/shared/host-protocol-testing'
import type {
  AgentMessage,
  RpcSessionState,
  RpcCommand,
  RpcResponseDataMap,
} from '@phosphor/shared/rpc'
import type { Delivery, HostRuntime } from '../session/runtime'
import { createLaneCommands } from '../lanes/commands'
import { createLaneCalls } from '../lanes/calls'
import { createLiveLanes } from '../lanes/live'
import { createRuntimeLanes } from '../lanes/runtime-host'
import { openStore } from '../lanes/store'
import { createUnattachedSnapshots } from '../lanes/transcript'
import { createAuthority } from './authority'
import { createConnection, hostProof } from './connection'
import { createLaneAdapter } from './lanes'

// The kit uses virtual time. Only git's read-only branch lookup is scripted;
// lane creation, SQLite, transcript reads and all protocol services are real.
vi.mock('@phosphor/session-runtime/git/git-exec', () => ({ git: async () => 'main' }))

type Session = {
  state: RpcSessionState
  messages: AgentMessage[]
  deliver: Delivery
  pending: Set<() => void>
}

const factory: HostConformanceFactory = async (limits) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'host-conformance-')))
  const repository = join(directory, 'repository')
  const sessionsRoot = join(directory, 'sessions')
  mkdirSync(repository)
  mkdirSync(sessionsRoot)
  const control = generateKeyPairSync('ed25519')
  const host = generateKeyPairSync('ed25519')
  const wrong = generateKeyPairSync('ed25519')
  const iat = Math.floor(Date.now() / 1000)
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'First viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: 1 })
  const connections = new Map<string, ReturnType<typeof createConnection>>()
  const sessions = new Map<string, Session>()
  let executions = 0
  let epoch = randomBytes(8).toString('hex')
  let adapter: ReturnType<typeof createLaneAdapter>
  const store = await openStore(join(directory, 'state'), process.getuid?.(), {
    now: Date.now,
    isConnected: (id) => adapter?.isConnected(id) ?? false,
    ...(limits.receiptsKept === undefined ? {} : { limits: { receiptsKept: limits.receiptsKept } }),
    ...(limits.receiptTtlMs === undefined ? {} : { receiptTtlMs: limits.receiptTtlMs }),
  })
  store.syncRepositories([repository])
  function save(s: Session) {
    const file = s.state.sessionFile
    if (!file) throw new Error('Missing scripted session file')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: s.state.sessionId }),
        ...s.messages.map((message, index) =>
          JSON.stringify({
            type: 'message',
            id: String(index),
            parentId: index ? String(index - 1) : null,
            message,
          }),
        ),
      ].join('\n') + '\n',
    )
  }
  function turn(s: Session) {
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Scripted reply' }],
      timestamp: Date.now(),
    }
    s.deliver({ kind: 'event', event: { type: 'agent_start' } })
    s.deliver({
      kind: 'event',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Scripted reply' },
      },
    })
    s.messages.push(message)
    s.state.messageCount = s.messages.length
    s.deliver({ kind: 'event', event: { type: 'message_end', message } })
    s.deliver({ kind: 'event', event: { type: 'agent_end', messages: [message] } })
    save(s)
    return { messages: 1, turns: 1 }
  }
  const runtime = {
    async start(request: unknown, deliver: Delivery = () => {}) {
      const sessionId = randomUUID()
      const sessionPath =
        typeof request === 'object' &&
        request !== null &&
        'sessionPath' in request &&
        typeof request.sessionPath === 'string'
          ? request.sessionPath
          : join(sessionsRoot, sessionId + '.jsonl')
      const previous = [...sessions.values()].find((s) => s.state.sessionFile === sessionPath)
      const s: Session = {
        state: {
          sessionId: previous?.state.sessionId ?? sessionId,
          sessionFile: sessionPath,
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          autoCompactionEnabled: true,
          messageCount: previous?.messages.length ?? 0,
          pendingMessageCount: 0,
        },
        messages: previous?.messages ?? [],
        deliver,
        pending: new Set(),
      }
      sessions.set(sessionId, s)
      save(s)
      return { sessionId, workspacePath: repository }
    },
    async stop(sessionId: string) {
      const s = sessions.get(sessionId)
      if (s) {
        for (const cancel of s.pending) cancel()
        save(s)
      }
    },
    async command(sessionId: string, cmd: RpcCommand): ReturnType<HostRuntime['command']> {
      const s = sessions.get(sessionId)
      if (!s) throw new Error('Missing scripted session')
      let data: RpcResponseDataMap[RpcCommand['type']]
      if (cmd.type === 'get_state') data = { ...s.state }
      else if (cmd.type === 'get_messages') data = { messages: [...s.messages] }
      else if (cmd.type === 'get_available_models') data = { models: [] }
      else if (cmd.type === 'get_commands') data = { commands: [] }
      else if (cmd.type === 'get_session_stats')
        data = {
          sessionId: s.state.sessionId,
          userMessages: 0,
          assistantMessages: s.messages.length,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: s.messages.length,
          cost: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
      else {
        executions++
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer)
            s.pending.delete(cancel)
            reject(new Error('Scripted interruption'))
          }
          const timer = setTimeout(() => {
            s.pending.delete(cancel)
            resolve()
          }, limits.commandDelayMs ?? 5)
          s.pending.add(cancel)
        })
        if (cmd.type === 'prompt') turn(s)
        if (cmd.type === 'set_model')
          s.state.model = {
            provider: cmd.provider,
            id: cmd.modelId,
            name: cmd.modelId,
            api: 'test',
            reasoning: false,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }
        if (cmd.type === 'set_thinking_level') s.state.thinkingLevel = cmd.level
        if (cmd.type === 'set_session_name') s.state.sessionName = cmd.name
      }
      return {
        type: 'response',
        command: cmd.type,
        success: true,
        ...(data === undefined ? {} : { data }),
      }
    },
    extensionUiResponse: () => {},
  } satisfies Pick<HostRuntime, 'start' | 'stop' | 'command' | 'extensionUiResponse'>
  const streamLimits = Object.fromEntries(
    Object.entries(limits).filter(([key]) =>
      [
        'subscriptionsPerConnection',
        'replayEvents',
        'replayBytes',
        'attentionReplay',
        'outboundFrameBytes',
        'sendQueueBytes',
      ].includes(key),
    ),
  )
  function compose() {
    let unattached: ReturnType<typeof createUnattachedSnapshots> = () => null
    const live = createLiveLanes({
      epoch,
      store,
      runtime,
      now: Date.now,
      log: () => {},
      limits: streamLimits,
      unattached: (id) => unattached(id),
    })
    unattached = createUnattachedSnapshots({
      store,
      summary: live.summaryFor,
      cursor: live.streams.cursor,
      sessionsRoot,
      log: () => {},
    })
    const binding = createRuntimeLanes({ runtime, store, live, log: () => {} })
    const commands = createLaneCommands({
      store,
      ...binding,
      runtime: binding,
      sessionFor: live.sessionFor,
      openDialogs: live.openDialogs,
      summaryFor: live.summaryFor,
      publish: live.publish,
      deliver: (...args) => adapter.deliver(...args),
      now: Date.now,
      log: () => {},
    })
    adapter = createLaneAdapter(
      {
        epoch,
        capabilities: ['sessions.read', 'sessions.control'],
        commands,
        calls: createLaneCalls({ store, live, runtime, unattached, now: Date.now, log: () => {} }),
        streams: live.streams,
        lanesTopic: live.lanesTopic,
        controllerPresence(clientId) {
          for (const lane of store.listLanes())
            if (lane.control.controller?.clientId === clientId)
              live.publish(lane.laneId, { kind: 'control', control: lane.control })
        },
      },
      {
        limits: {
          ...streamLimits,
          ...(limits.pendingCommandsPerConnection === undefined
            ? {}
            : { pendingCommandsPerConnection: limits.pendingCommandsPerConnection }),
        },
      },
    )
    return { live, commands }
  }
  let active = compose()
  function session(laneId: string) {
    const id = active.live.sessionFor(laneId)
    const s = id === null ? undefined : sessions.get(id)
    if (!s) throw new Error('Missing live scripted lane')
    return s
  }
  function hello() {
    return {
      hostId: claims.hostId,
      hostVersion: 'test',
      protocolVersion: 1 as const,
      runtimeEpoch: epoch,
      capabilities: [...claims.caps],
    }
  }
  async function close() {
    for (const c of connections.values()) c.close(1001)
    for (const s of sessions.values()) for (const cancel of s.pending) cancel()
    await active.commands.close()
    active.live.close()
  }
  return {
    claims,
    publicKey: Buffer.from(host.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url'),
    connect() {
      const pair = createLoopbackPair()
      const connection = createConnection({
        socket: pair.server,
        authority,
        origin: claims.iss,
        hello: hello(),
        key: host.privateKey,
        keyset: { get: async (kid) => (kid === claims.kid ? control.publicKey : undefined) },
        handler: adapter.handler,
        admit: (id) =>
          [...connections.values()].filter((c) => c.clientId() === id).length <
          (limits.connectionsPerClient ?? HOST_LIMITS.connectionsPerClient),
        limits: Object.fromEntries(
          Object.entries(limits).filter(([key]) =>
            ['authTimeoutMs', 'inboundFrameBytes', 'connectionsPerClient'].includes(key),
          ),
        ),
        onClose: (id) => connections.delete(id),
      })
      connections.set(connection.connectionId, connection)
      return { ...pair, socket: pair.client }
    },
    mintGrant: (overrides = {}, badSignature = false) =>
      encodeGrant({ ...claims, ...overrides }, (bytes) =>
        sign(null, bytes, badSignature ? wrong.privateKey : control.privateKey),
      ),
    verifyProof: (ready: Extract<HostFrame, { type: 'ready' }>, challenge: string) =>
      ready.hello.hostId === claims.hostId &&
      verify(
        null,
        Buffer.from(helloProofMessage(ready.hello.hostId, ready.hello.runtimeEpoch, challenge)),
        host.publicKey,
        Buffer.from(ready.proof, 'base64url'),
      ),
    signHelloProof: (hostId, runtimeEpoch, challenge) =>
      hostProof({ ...hello(), hostId, runtimeEpoch }, challenge, host.privateKey),
    requestId: randomUUID,
    driver: {
      emitTurn: (id) => turn(session(id)),
      openDialog: (id, dialogId = 'dialog') =>
        session(id).deliver({
          kind: 'extension-ui',
          request: {
            type: 'extension_ui_request',
            id: dialogId,
            method: 'confirm',
            title: 'Confirm',
            message: '?',
          },
        }),
      emitUi: (id, request) => {
        // Even a failed runtime may emit a final UI push before transport EOF.
        const lane = store.getLane(id)
        const s = [...sessions.values()].findLast((s) => s.state.sessionFile === lane?.sessionFile)
        if (!s) throw new Error('Missing scripted lane')
        s.deliver({ kind: 'extension-ui', request })
      },
      failLane: (id) => {
        const s = session(id)
        for (const cancel of s.pending) cancel()
        s.deliver({ kind: 'exit', code: 1, signal: null, expected: false })
      },
      async restart() {
        await close()
        store.markInterrupted()
        epoch = randomBytes(8).toString('hex')
        active = compose()
      },
      revokeSession: (id) =>
        authority.accept({
          accepted: true,
          nextInSec: 30,
          revoked: { sessions: [id], clients: [] },
        }),
      revokeClient: (id) =>
        authority.accept({
          accepted: true,
          nextInSec: 30,
          revoked: { sessions: [], clients: [id] },
        }),
      executions: () => executions,
      async stop() {
        await close()
        store.close()
        rmSync(directory, { recursive: true, force: true })
      },
    },
  }
}

defineHostConformance('real Host remote lanes', factory)
