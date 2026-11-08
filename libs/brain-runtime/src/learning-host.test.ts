import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import projection from './__fixtures__/learning-source/pi-1.4-projection.json'
import {
  registerLearningCarrier,
  type LearningCarrierApi,
} from '../../pi-extensions/pi-ext/brain-learning-carrier'
import type { LearningCarrierContext } from '../../pi-extensions/pi-ext/brain-learning-carrier-operation'
import type { LearningPiSdk } from '../../pi-extensions/pi-ext/brain-learning-carrier-sdk'
import type { BrainLearningRequest } from '@phosphor/shared/brain-learning'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import { SessionActivity } from '@phosphor/session-runtime/pi/session-activity'
import type { PiRpcClient, PiSpawnOptions } from '@phosphor/session-runtime/pi/rpc-client'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { sessionFixture } from '@phosphor/session-runtime/pi/__fixtures__/session-runtime'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { createLearningHost } from './learning-host'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const model = {
  provider: 'openai',
  id: 'exact',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  contextWindow: 200000,
  maxTokens: 8000,
}
const binding = {
  provider: model.provider,
  modelId: model.id,
  api: model.api,
  endpoint: model.baseUrl,
  accountId: 'current-native-slot',
  authMode: 'oauth' as const,
  thinkingLevel: 'high' as const,
}
const sdk: LearningPiSdk = {
  buildSessionProjection: (entries, leaf) => {
    expect(leaf).toBe('thinking')
    return {
      entries: projection.projection.entries.map((entry) => ({
        ...entry,
        sourceEntry: entries.find(
          (row) => (row as { id: string }).id === entry.sourceEntry.id,
        )! as { id: string; type: string },
      })),
    }
  },
  convertToLlm: (messages) => {
    const index = projection.projection.entries.findIndex(
      (entry) => JSON.stringify(entry.messages) === JSON.stringify(messages),
    )
    if (index < 0) throw new Error('Unexpected synthetic projection conversion')
    return structuredClone(projection.wireByEntry[index]!)
  },
}
interface TestCapabilities {
  boundRequestVersion: number
  tools: string[]
  stateGate?: Promise<void>
  authIdentityFence?: string
  sourceBinding?: {
    binding: typeof binding
    authIdentityFence: string
    sessionId: string
    selectedLeafId: string
    settled: true
  }
}
async function fakeRequest(
  command: RpcCommand,
  ctx: LearningCarrierContext,
  commands: Map<string, Parameters<LearningCarrierApi['registerCommand']>[1]>,
  running: Set<Promise<unknown>>,
  capabilities: { stateGate?: Promise<void> },
  options: PiSpawnOptions,
) {
  if (command.type === 'get_state') {
    await capabilities.stateGate
    return { success: true, data: { model, thinkingLevel: 'high' } }
  }
  if (command.type === 'get_commands')
    return {
      success: true,
      data: {
        commands: [...commands.keys()].map((name) => ({
          name,
          source: 'extension',
          sourceInfo: { path: options.extensions![0] },
        })),
      },
    }
  if (command.type !== 'prompt') throw new Error(`Unaudited command ${command.type}`)
  const [name, ...args] = command.message.slice(1).split(' ')
  const operation = commands.get(name!)!.handler(args.join(' '), ctx)
  running.add(operation)
  try {
    await operation
  } finally {
    running.delete(operation)
  }
  return { success: true, data: { disposition: 'handled' } }
}
type TestStream = ((context: unknown, options: unknown) => unknown) & {
  result(signal: AbortSignal): Promise<unknown>
}
function fakeClient(options: PiSpawnOptions, stream: TestStream, capabilities: TestCapabilities) {
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const commands = new Map<string, Parameters<LearningCarrierApi['registerCommand']>[1]>()
  const branch: unknown[] = [],
    running = new Set<Promise<unknown>>()
  const client = Object.assign(new EventEmitter(), {
    alive: false,
    pid: 123,
    sessionFile: undefined,
    activity: new SessionActivity(),
    spawn: () => {
      client.alive = true
      events.get('session_start')?.({}, ctx)
    },
    dispose: async () => {
      events.get('session_shutdown')?.({}, ctx)
      await Promise.allSettled([...running])
      client.alive = false
      client.emit('exit', { code: 0, expected: true, signal: null })
    },
    killNow: vi.fn(),
    request: vi.fn((command: RpcCommand) =>
      fakeRequest(command, ctx, commands, running, capabilities, options),
    ),
  })
  const ctx: LearningCarrierContext = {
    model,
    thinkingLevel: 'high',
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      boundRequestVersion: capabilities.boundRequestVersion,
      find: () => model,
      prepareBoundRequest: async (_actual, opts) => {
        expect(opts.allowVirtual).toBe(false)
        expect(opts.allowFallback).toBe(false)
        return {
          binding,
          authIdentityFence: capabilities.authIdentityFence ?? 'synthetic-login-epoch',
          streamSimple: (context, config) => {
            stream(context, config)
            return { result: () => stream.result(config.signal) }
          },
        }
      },
    },
    ui: {
      setStatus: (statusKey, statusText) =>
        client.emit('extension-ui', { method: 'setStatus', statusKey, statusText }),
    },
  }
  registerLearningCarrier(
    {
      on: (name, handler) => {
        events.set(name, handler)
      },
      appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
      getActiveTools: () => capabilities.tools,
      getAllTools: () => capabilities.tools,
      registerCommand: (name, command) => {
        commands.set(name, command)
      },
    },
    options.env!.PHOSPHOR_LEARNING_CONTROL!,
    options.env!.PHOSPHOR_BRAIN_JOB_ID!,
    options.env!.PHOSPHOR_LEARNING_NONCE!,
    async () => sdk,
  )
  return client as unknown as PiRpcClient
}
async function source(root: string) {
  const workspacePath = join(root, 'folder'),
    sessionsRoot = join(root, 'sessions')
  await mkdir(workspacePath)
  const dir = sessionDirForCwd(workspacePath, sessionsRoot)
  await mkdir(dir, { recursive: true })
  const id = '01a12345-1234-4234-8234-123456789abc',
    sessionPath = join(dir, `2026-01-01_${id}.jsonl`)
  const entries = structuredClone(projection.entries) as Array<Record<string, unknown>>
  Object.assign(entries.find((entry) => entry.id === 'answer')!.message!, {
    provider: model.provider,
    model: model.id,
    api: model.api,
    stopReason: 'stop',
  })
  entries.push(
    {
      type: 'model_change',
      id: 'model',
      parentId: projection.leafId,
      provider: model.provider,
      modelId: model.id,
    },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'high' },
  )
  const original =
    [{ type: 'session', version: 3, id, cwd: workspacePath }, ...entries]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  await writeFile(sessionPath, original)
  return { target: { workspacePath, sessionPath }, sessionsRoot, original }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'learning-host-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const selected = await source(root),
    directory = join(root, 'private'),
    extensionPath = join(root, 'brain-learning-carrier.mjs')
  await writeFile(extensionPath, '// synthetic resource')
  const capabilities: TestCapabilities = { boundRequestVersion: 1, tools: [] }
  const stream = Object.assign(vi.fn(), {
    result: vi.fn(async (_signal: AbortSignal) => ({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: '{"type":"no_findings"}' }],
      usage: { input: 11, output: 7, cacheRead: 9, cacheWrite: 0 },
    })),
  })
  const registry = new SessionRegistry({
    assertCanStart: () => {},
    createClient: (options) => fakeClient(options, stream, capabilities),
  })
  cleanups.push(() => registry.disposeAll())
  const h = sessionFixture(),
    paths = createSessionPathRuntime()
  const spawn = createSessionStartup({ ...h.runtime, registry })
  const sessions = createSessionService({
    registry,
    paths,
    spawn: (options, _delivery, execution) => spawn(options, h.sink, execution),
    isStub: () => false,
    packages: h.runtime.policy.packages,
    readBudget: () => '200k',
    withBudgetCompaction: async (_id, _command, run) => run(),
    forgetAccount: () => {},
    routines: {
      owns: () => false,
      sessionForPath: () => undefined,
      observe: () => {},
      cancel: async () => {},
    },
  })
  const host = createLearningHost({
    directory,
    extensionPath,
    registry,
    sessions,
    paths,
    sessionsRoot: selected.sessionsRoot,
    resolve: async () => ({
      binaryPath: '/synthetic/pi',
      agentDir: '/synthetic/agent',
      env: { HOME: '/synthetic/home' },
      sourceBinding: capabilities.sourceBinding,
    }),
    onError: (error) => {
      throw error
    },
  })
  return { ...selected, root, host, registry, sessions, stream, directory, capabilities }
}
function request(
  prepared: Awaited<ReturnType<ReturnType<typeof createLearningHost>['prepare']>>,
): BrainLearningRequest {
  return {
    version: 1,
    jobId: 'job',
    source: prepared.checkpoint.source,
    binding: prepared.binding,
    alreadyCovered: [],
    suffixTimestamp: 1,
    deadlineMs: 5000,
    maxOutputTokens: prepared.maxOutputTokens,
  }
}
it('real host/service/carrier transport preflights without inference and performs exactly one direct call with original selected content', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  expect(f.stream).not.toHaveBeenCalled()
  expect(prepared.branch).toBeNull()
  expect(prepared.maxOutputTokens).toBe(8000)
  expect(prepared.evidence.map((item) => item.text).join('\n')).toContain('final assistant fact')
  expect(prepared.evidence.map((item) => item.text).join('\n')).not.toContain(
    'explicitly context-omitted fact',
  )
  const result = await prepared.run(request(prepared), new AbortController().signal)
  expect(result.outcome).toEqual({ type: 'no_findings' })
  expect(result.usage).toMatchObject({ input: 11, output: 7 })
  expect(f.stream).toHaveBeenCalledOnce()
  const [context, config] = f.stream.mock.calls[0]!
  expect(JSON.stringify(context)).toContain('retained reasoning')
  expect(context.messages.at(-1).content).toContain('separate learning agent')
  expect(context).not.toHaveProperty('tools')
  expect(config.maxRetries).toBe(0)
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
  await expect(prepared.run(request(prepared), new AbortController().signal)).rejects.toThrow(
    'at most once',
  )
})
it('disposes a preflight-only carrier and copied source without touching original bytes', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  await prepared.dispose()
  await prepared.dispose()
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it('stock pi fails the concrete prerequisite with no generation and no owned process/file leak', async () => {
  const f = await fixture()
  f.capabilities.boundRequestVersion = 0
  await expect(f.host.prepare(f.target, 'job', new AbortController().signal)).rejects.toThrow(
    'boundRequestVersion',
  )
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('cancels a noncooperative response, terminates its owner, and drops late results', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  f.stream.result.mockImplementation(async () => new Promise(() => {}))
  const cancel = new AbortController(),
    running = prepared.run(request(prepared), cancel.signal)
  await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce())
  cancel.abort(new Error('cancelled'))
  await expect(running).rejects.toThrow()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it('keeps failed response usage sanitized without exposing error/provider configuration', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  f.stream.result.mockResolvedValue({
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: 'not valid JSON' }],
    usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
  })
  const failure = prepared.run(request(prepared), new AbortController().signal)
  await expect(failure).rejects.toMatchObject({
    learningUsage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null },
  })
  expect(await readdir(f.directory)).toEqual([])
})
it('kills a noncooperative owned response at the host deadline without waiting for its stream result', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  f.stream.result.mockImplementation(async () => new Promise(() => {}))
  await expect(
    prepared.run({ ...request(prepared), deadlineMs: 50 }, new AbortController().signal),
  ).rejects.toThrow()
  expect(f.stream).toHaveBeenCalledOnce()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('rejects re-authentication in the same current slot between prepare and run before generation', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  f.capabilities.authIdentityFence = 'replacement-login'
  await expect(prepared.run(request(prepared), new AbortController().signal)).rejects.toThrow()
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('cancels startup, purges its copy, handles late readiness and remains retryable', async () => {
  const f = await fixture(),
    cancel = new AbortController()
  let ready = () => {}
  f.capabilities.stateGate = new Promise<void>((resolve) => {
    ready = resolve
  })
  const preparation = f.host.prepare(f.target, 'job', cancel.signal)
  await vi.waitFor(() => expect(f.registry.list()).toHaveLength(1))
  cancel.abort(new Error('startup cancelled'))
  await expect(preparation).rejects.toThrow()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
  ready()
  f.capabilities.stateGate = undefined
  const retried = await f.host.prepare(f.target, 'job', new AbortController().signal)
  await retried.dispose()
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it('refuses unexpected executable tools at startup without inference and cleans the failed owner', async () => {
  const f = await fixture()
  f.capabilities.tools = ['unaudited']
  await expect(f.host.prepare(f.target, 'job', new AbortController().signal)).rejects.toThrow()
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('refuses a concurrent owned carrier rather than replacing it', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  await expect(f.host.prepare(f.target, 'other-job', new AbortController().signal)).rejects.toThrow(
    'One learning carrier',
  )
  expect(f.registry.list()).toHaveLength(1)
  await prepared.dispose()
})
it('retains failed cleanup ownership so disposal and the next preparation can retry safely', async () => {
  const f = await fixture(),
    prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  vi.spyOn(f.sessions, 'disposeBrain').mockRejectedValueOnce(
    new Error('synthetic disposal failure'),
  )
  await expect(prepared.dispose()).rejects.toThrow('synthetic disposal failure')
  expect(f.registry.list()).toHaveLength(1)
  await prepared.dispose()
  const retry = await f.host.prepare(f.target, 'job', new AbortController().signal)
  await retry.dispose()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('retries retained cleanup after a preparation failure instead of leaking its process or allocating another first', async () => {
  const f = await fixture()
  f.capabilities.boundRequestVersion = 0
  vi.spyOn(f.sessions, 'disposeBrain').mockRejectedValueOnce(
    new Error('synthetic preparation cleanup failure'),
  )
  await expect(f.host.prepare(f.target, 'job', new AbortController().signal)).rejects.toThrow(
    'cleanup failure',
  )
  expect(f.registry.list()).toHaveLength(1)
  f.capabilities.boundRequestVersion = 1
  const retry = await f.host.prepare(f.target, 'job', new AbortController().signal)
  expect(f.registry.list()).toHaveLength(1)
  await retry.dispose()
  expect(f.registry.list()).toEqual([])
  expect(await readdir(f.directory)).toEqual([])
})
it('refuses oversized projected input before stream creation, without clipping or re-compaction', async () => {
  const f = await fixture(),
    oldWindow = model.contextWindow
  try {
    model.contextWindow = 100
    await expect(f.host.prepare(f.target, 'job', new AbortController().signal)).rejects.toThrow()
    expect(f.stream).not.toHaveBeenCalled()
    expect(f.registry.list()).toEqual([])
    expect(await readdir(f.directory)).toEqual([])
    expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
  } finally {
    model.contextWindow = oldWindow
  }
})
function registerSource(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = f.original
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const header = rows.shift()!,
    activity = new SessionActivity()
  const state = {
    sessionId: header.id,
    sessionFile: f.target.sessionPath,
    model,
    thinkingLevel: 'high',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  }
  const requests = vi.fn(async (command: RpcCommand) => {
    if (command.type === 'get_state') {
      activity.requested('state', 'get_state')
      activity.responded({
        id: 'state',
        type: 'response',
        command: 'get_state',
        success: true,
        data: state,
      })
      return { success: true, data: state }
    }
    if (command.type === 'get_entries')
      return { success: true, data: { entries: rows, leafId: 'thinking' } }
    throw new Error('Original source mutation forbidden')
  })
  const source = {
    sessionId: 'original-live',
    workspacePath: f.target.workspacePath,
    startupComplete: true,
    client: { alive: true, activity, request: requests },
  }
  const list = f.registry.list.bind(f.registry),
    get = f.registry.get.bind(f.registry)
  vi.spyOn(f.registry, 'list').mockImplementation(() => [
    {
      sessionId: source.sessionId,
      workspacePath: source.workspacePath,
      diskPath: f.target.sessionPath,
    },
    ...list(),
  ])
  vi.spyOn(f.registry, 'get').mockImplementation((id) =>
    id === source.sessionId ? (source as unknown as NonNullable<ReturnType<typeof get>>) : get(id),
  )
  return {
    requests,
    binding: {
      binding,
      authIdentityFence: 'synthetic-login-epoch',
      sessionId: String(header.id),
      selectedLeafId: 'thinking',
      settled: true as const,
    },
  }
}
it('refuses live source account substitution without a real source-process identity-epoch attestation', async () => {
  const f = await fixture(),
    original = registerSource(f)
  await expect(f.host.prepare(f.target, 'job', new AbortController().signal)).rejects.toThrow(
    'get_auth_binding',
  )
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.registry.list().map((item) => item.sessionId)).toEqual(['original-live'])
  expect(
    original.requests.mock.calls.every(([command]) =>
      ['get_state', 'get_entries'].includes(command.type),
    ),
  ).toBe(true)
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it('can consume a supplied trusted source-process binding rather than permanently rejecting every live source', async () => {
  const f = await fixture(),
    original = registerSource(f)
  f.capabilities.sourceBinding = original.binding
  const prepared = await f.host.prepare(f.target, 'job', new AbortController().signal)
  expect(prepared.authIdentityFence).toBe(original.binding.authIdentityFence)
  await prepared.dispose()
  expect(f.registry.list().map((item) => item.sessionId)).toEqual(['original-live'])
  expect(f.stream).not.toHaveBeenCalled()
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
