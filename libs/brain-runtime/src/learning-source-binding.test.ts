import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionActivity } from '@phosphor/session-runtime/pi/session-activity'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { admitLearningSource } from './learning-source-admission'
import { readLearningSourceBinding } from './learning-source-binding'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const routes = [
  ['openai', 'openai-responses', 'https://api.openai.com/v1'],
  ['openai-codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api'],
  ['anthropic', 'anthropic-messages', 'https://api.anthropic.com'],
] as const
async function sourceFile(route: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-binding-')))
  roots.push(root)
  const workspacePath = join(root, 'workspace'),
    sessionsRoot = join(root, 'sessions')
  await mkdir(workspacePath)
  const directory = sessionDirForCwd(workspacePath, sessionsRoot)
  await mkdir(directory, { recursive: true })
  const sessionId = '01a12345-1234-4234-8234-123456789abc'
  const target = { workspacePath, sessionPath: join(directory, `2026-01-01_${sessionId}.jsonl`) }
  const model = { provider: route[0]!, id: 'exact', api: route[1]!, baseUrl: route[2]! }
  const entries = [
    { type: 'thinking_level_change', id: 't', parentId: null, thinkingLevel: 'high' },
    { type: 'message', id: 'u', parentId: 't', message: { role: 'user', content: 'task' } },
    {
      type: 'message',
      id: 'a',
      parentId: 'u',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        provider: model.provider,
        model: model.id,
        api: model.api,
      },
    },
  ]
  const original =
    [{ type: 'session', version: 3, id: sessionId, cwd: workspacePath }, ...entries]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  await writeFile(target.sessionPath, original)
  const state = {
    sessionId,
    sessionFile: target.sessionPath,
    model,
    thinkingLevel: 'high',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  }
  return { root, target, original, state, entries, model, sessionId, workspacePath, sessionsRoot }
}
function liveSource(file: Awaited<ReturnType<typeof sourceFile>>) {
  const { target, state, entries, model, sessionId, workspacePath, sessionsRoot } = file
  const activity = new SessionActivity()
  const receipt = {
    available: true,
    sourceSessionId: sessionId,
    binding: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      endpoint: model.baseUrl,
      accountId: 'opaque-slot',
      authMode: 'oauth',
    },
    authIdentityFence: 'opaque-epoch',
  }
  const control = {
    receipt: receipt as unknown,
    leafId: 'a',
    registered: true,
    success: true,
    mutate: async () => {},
  }
  const request = vi.fn(async (command: RpcCommand) => {
    if (command.type === 'get_state') {
      activity.requested('state', 'get_state')
      activity.responded({
        id: 'state',
        type: 'response',
        command: 'get_state',
        success: true,
        data: state,
      })
      return { success: true, data: structuredClone(state) }
    }
    if (command.type === 'get_entries')
      return { success: true, data: { entries: structuredClone(entries), leafId: control.leafId } }
    if (command.type !== 'get_auth_binding') throw new Error('Source mutation forbidden')
    await control.mutate()
    return { success: control.success, data: control.receipt }
  })
  const live = {
    sessionId: 'live-owner',
    workspacePath,
    startupComplete: true,
    client: { alive: true, activity, request },
  } as unknown as LiveSession
  const owners = [{ sessionId: live.sessionId, workspacePath, diskPath: target.sessionPath }]
  const runtime = {
    sessionsRoot,
    paths: createSessionPathRuntime(),
    registry: {
      list: () => (control.registered ? owners : []),
      get: () => (control.registered ? live : undefined),
    },
  }
  return { ...file, live, owners, runtime, request, activity, control, receipt }
}
async function fixture(route: readonly string[] = routes[0]) {
  const file = await sourceFile(route)
  const f = liveSource(file)
  const { root, target, runtime, request } = f
  const admitted = await admitLearningSource(
    runtime,
    target,
    join(root, 'snapshot.jsonl'),
    'job',
    new AbortController().signal,
  )
  request.mockClear()
  const read = () =>
    readLearningSourceBinding(
      runtime,
      target,
      admitted.liveSessionId!,
      admitted.frozen.source,
      new AbortController().signal,
    )
  return { ...f, admitted, read }
}

it.each(routes)(
  'attests only current settled %s process with metadata reads and unchanged source bytes',
  async (...route) => {
    const f = await fixture(route)
    expect(await f.read()).toEqual({
      binding: { ...f.receipt.binding, thinkingLevel: 'high' },
      authIdentityFence: 'opaque-epoch',
      sessionId: f.state.sessionId,
      selectedLeafId: 'a',
      settled: true,
    })
    expect(f.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_state',
      'get_entries',
      'get_auth_binding',
      'get_state',
      'get_entries',
    ])
    expect(f.request.mock.calls[2]).toEqual([{ type: 'get_auth_binding' }])
    expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
  },
)
it.each([
  undefined,
  {},
  { available: false, reason: 'unavailable' },
  { available: false, reason: 'changed' },
  { available: true },
  { available: 'true' },
])('refuses missing, changed or malformed receipt %j without disk fallback', async (receipt) => {
  const f = await fixture()
  f.control.receipt = receipt
  await expect(f.read()).rejects.toThrow('get_auth_binding')
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it.each([
  ['sourceSessionId', 'another-session'],
  ['authIdentityFence', 'unsafe epoch'],
  ['authIdentityFence', ''],
  ['authIdentityFence', null],
])('refuses receipt %s mismatch or unsafe opaque identity', async (key, value) => {
  const f = await fixture()
  f.control.receipt = { ...f.receipt, [key]: value }
  await expect(f.read()).rejects.toThrow()
})
it.each([
  ['provider', 'foreign'],
  ['modelId', 'other'],
  ['api', 'foreign-api'],
  ['authMode', 'cli'],
  ['accountId', 'unsafe slot'],
  ['accountId', null],
  ['endpoint', 'https://other.example'],
])('refuses wrong binding %s', async (key, value) => {
  const f = await fixture()
  f.control.receipt = { ...f.receipt, binding: { ...f.receipt.binding, [key]: value } }
  await expect(f.read()).rejects.toThrow()
})
it.each([
  'not a url',
  'file:///tmp/local',
  'https://user:secret@example.com',
  'https://example.com/?key=private',
  'https://example.com/#fragment',
])('refuses unsafe endpoints even if the current model agrees: %s', async (endpoint) => {
  const f = await fixture()
  f.state.model.baseUrl = endpoint
  f.receipt.binding.endpoint = endpoint
  await expect(f.read()).rejects.toThrow('endpoint')
})
it('refuses stock/unsupported command errors and failed responses without leaking their payload', async () => {
  const f = await fixture()
  f.control.mutate = async () => {
    throw new Error('synthetic private provider detail')
  }
  await expect(f.read()).rejects.toThrow('upgraded pi required')
  f.control.mutate = async () => {}
  f.control.success = false
  await expect(f.read()).rejects.toThrow('unavailable')
})
it.each([
  'bytes',
  'leaf',
  'queue',
  'revision',
  'registry',
  'owner-object',
  'alive',
  'startup',
  'private',
  'model',
  'thinking',
  'api',
  'entries',
])('refuses source %s race around the attestation', async (race) => {
  const f = await fixture()
  f.control.mutate = async () => {
    if (race === 'bytes') await writeFile(f.target.sessionPath, f.original + '\n')
    if (race === 'leaf') f.control.leafId = 'u'
    if (race === 'queue') f.state.pendingMessageCount = 1
    if (race === 'revision') {
      f.activity.event({ type: 'agent_start' })
      f.activity.event({ type: 'agent_settled', aborted: false })
    }
    if (race === 'registry') f.control.registered = false
    if (race === 'owner-object') vi.spyOn(f.runtime.registry, 'get').mockReturnValue({ ...f.live })
    if (race === 'alive') Object.assign(f.live.client, { alive: false })
    if (race === 'startup') f.live.startupComplete = false
    if (race === 'private') f.live.owner = { kind: 'brain', jobId: 'foreign' }
    if (race === 'model') f.state.model.id = 'changed'
    if (race === 'thinking') f.state.thinkingLevel = 'off'
    if (race === 'api') f.state.model.api = 'foreign'
    if (race === 'entries') f.entries[0]!.thinkingLevel = 'off'
  }
  await expect(f.read()).rejects.toThrow()
  expect(f.request.mock.calls.every(([command]) => command.type.startsWith('get_'))).toBe(true)
})
it('rechecks the full admitted digest before querying and refuses conflicting owners', async () => {
  const f = await fixture()
  await writeFile(f.target.sessionPath, f.original.replace('done', 'changed'))
  await expect(f.read()).rejects.toThrow('bytes changed')
  expect(f.request).not.toHaveBeenCalled()
  await writeFile(f.target.sessionPath, f.original)
  f.owners.push({ ...f.owners[0]!, sessionId: 'other-owner' })
  await expect(f.read()).rejects.toThrow('owner')
  expect(f.request).not.toHaveBeenCalled()
})
it('refuses foreign API and CLI providers before requesting identity rather than inferring accounts', async () => {
  for (const route of [
    ['pi-claude-cli', 'anthropic-messages', routes[2][2]],
    ['openai', 'foreign-api', routes[0][2]],
  ]) {
    const f = await fixture(route)
    await expect(f.read()).rejects.toThrow('unqualified')
    expect(f.request.mock.calls.some(([command]) => command.type === 'get_auth_binding')).toBe(
      false,
    )
  }
})
it.each(['get_state', 'get_entries'] as const)(
  'refuses failed %s observations before querying binding',
  async (type) => {
    const f = await fixture(),
      request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (command) =>
      command.type === type ? { success: false, data: undefined } : request(command),
    )
    await expect(f.read()).rejects.toThrow()
    expect(f.request.mock.calls.some(([command]) => command.type === 'get_auth_binding')).toBe(
      false,
    )
  },
)
it.each(['queue', 'leaf', 'startup', 'alive'] as const)(
  'refuses already invalid %s without identity lookup',
  async (kind) => {
    const f = await fixture()
    if (kind === 'queue') f.state.pendingMessageCount = 1
    if (kind === 'leaf') f.control.leafId = 'u'
    if (kind === 'startup') f.live.startupComplete = false
    if (kind === 'alive') Object.assign(f.live.client, { alive: false })
    await expect(f.read()).rejects.toThrow()
    expect(f.request.mock.calls.some(([command]) => command.type === 'get_auth_binding')).toBe(
      false,
    )
  },
)
it('returns only the metadata contract, never unexpected provider fields', async () => {
  const f = await fixture()
  f.control.receipt = {
    ...f.receipt,
    credential: 'synthetic-not-for-return',
    binding: { ...f.receipt.binding, credential: 'synthetic-not-for-return' },
  }
  expect(JSON.stringify(await f.read())).not.toContain('synthetic-not-for-return')
})
it('holds the existing source path lock through attestation, without blocking unrelated paths', async () => {
  const f = await fixture()
  let entered = () => {},
    release = () => {}
  const querying = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.control.mutate = async () => {
    entered()
    await gate
  }
  const reading = f.read()
  await querying
  let samePathEntered = false,
    unrelatedEntered = false
  const samePath = f.runtime.paths.withSessionPath(f.target.sessionPath, async () => {
    samePathEntered = true
  })
  await f.runtime.paths.withSessionPath(join(f.target.workspacePath, 'other.jsonl'), async () => {
    unrelatedEntered = true
  })
  expect(samePathEntered).toBe(false)
  expect(unrelatedEntered).toBe(true)
  release()
  await reading
  await samePath
  expect(samePathEntered).toBe(true)
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
it('cancels a noncooperative metadata query and ignores late receipt without paid work or source writes', async () => {
  const f = await fixture(),
    cancel = new AbortController()
  let entered = () => {},
    release = () => {}
  const querying = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.control.mutate = async () => {
    entered()
    await gate
  }
  const reading = readLearningSourceBinding(
    f.runtime,
    f.target,
    f.admitted.liveSessionId!,
    f.admitted.frozen.source,
    cancel.signal,
  )
  await querying
  cancel.abort(new Error('metadata cancelled'))
  await expect(reading).rejects.toThrow('metadata cancelled')
  const before = f.request.mock.calls.length
  release()
  await Promise.resolve()
  expect(f.request).toHaveBeenCalledTimes(before)
  expect(f.request.mock.calls.every(([command]) => command.type.startsWith('get_'))).toBe(true)
  expect(await readFile(f.target.sessionPath, 'utf8')).toBe(f.original)
})
