import { afterEach, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { createSessionPathRuntime, sessionPathKey } from './session-path-lock'
import type { RpcCommand } from '@shared/rpc'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrainExecutionProfile } from './brain-execution-profile'
import { BRAIN_OWNER_CUSTOM_TYPE } from './brain-session-owner'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const runtime: SessionServiceRuntime<undefined> = {
    registry: h.registry,
    paths: createSessionPathRuntime(),
    spawn: (options, _delivery, execution) => h.spawn(options, h.sink, execution),
    isStub: () => false,
    packages: h.runtime.policy.packages,
    readBudget: h.runtime.budget.read,
    withBudgetCompaction: h.budget.withBudgetCompaction,
    forgetAccount: h.runtime.accounts.forget,
    routines: {
      owns: () => false,
      sessionForPath: () => undefined,
      observe: vi.fn(),
      cancel: vi.fn(async () => {}),
    },
  }
  return { ...h, service: createSessionService(runtime), serviceRuntime: runtime }
}

it.each<RpcCommand>([
  { type: 'prompt', message: '/mcp reconnect secret' },
  { type: 'prompt', message: 'ordinary user input' },
  { type: 'steer', message: 'injection' },
  { type: 'follow_up', message: 'injection' },
  { type: 'bash', command: 'printf bypass' },
  { type: 'set_model', provider: 'other', modelId: 'other' },
  { type: 'compact' },
  { type: 'switch_session', sessionPath: '/other' },
  { type: 'new_session' },
  { type: 'fork', entryId: 'entry' },
  { type: 'clone' },
  { type: 'export_html', outputPath: '/tmp/export.html' },
  { type: 'abort' },
])('refuses manual $type on a Brain-owned lane before any RPC', async (command) => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  h.clients[0]!.request.mockClear()
  await expect(h.service.command(live.sessionId, command)).rejects.toThrow('Brain')
  expect(h.clients[0]!.request).not.toHaveBeenCalled()
})

it('refuses extension UI and MCP control on a Brain-owned lane', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  expect(() =>
    h.service.respond(live.sessionId, {
      type: 'extension_ui_response',
      id: 'dialog',
      confirmed: true,
    }),
  ).toThrow('Brain')
  await expect(h.service.mcpControl(live.sessionId, 'connector', 'inspect')).rejects.toThrow(
    'Brain',
  )
  await expect(h.service.mcpControl(live.sessionId, 'connector', 'reconnect')).rejects.toThrow(
    'Brain',
  )
  expect(h.clients[0]!.respondToExtensionUI).not.toHaveBeenCalled()
})

it('allows observation without running the interactive budget gate', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  vi.spyOn(h.serviceRuntime, 'withBudgetCompaction')
  h.clients[0]!.request.mockClear()
  await h.service.command(live.sessionId, { type: 'get_entries' })
  expect(h.clients[0]!.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_entries' })
  expect(h.serviceRuntime.withBudgetCompaction).not.toHaveBeenCalled()
})

async function brainTranscript() {
  const dir = await mkdtemp(join(tmpdir(), 'brain-admission-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'processor.jsonl')
  await writeFile(
    path,
    [
      { type: 'session', id: 'brain-session', cwd: '/isolated' },
      {
        type: 'custom',
        customType: BRAIN_OWNER_CUSTOM_TYPE,
        data: { kind: 'brain', jobId: 'job-1' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  )
  return { dir, path }
}

it('refuses manual resume/fork/switch of persisted Brain transcripts, including symlink aliases', async () => {
  const h = fixture()
  const { dir, path } = await brainTranscript()
  const alias = join(dir, 'alias.jsonl')
  await symlink(path, alias)
  for (const sessionPath of [path, alias]) {
    await expect(h.service.create({ workspacePath: '/repo', sessionPath })).rejects.toThrow('Brain')
    await expect(
      h.service.create({ workspacePath: '/repo', forkFrom: sessionPath }),
    ).rejects.toThrow('Brain')
  }
  expect(h.clients).toHaveLength(0)
  const live = await h.service.create({ workspacePath: '/repo' })
  h.clients[0]!.request.mockClear()
  await expect(
    h.service.command(live.sessionId, { type: 'switch_session', sessionPath: alias }),
  ).rejects.toThrow('Brain')
  expect(h.clients[0]!.request).not.toHaveBeenCalled()
})

it('admits trusted resume only for matching persisted ownership in its own path-lock domain', async () => {
  const h = fixture()
  const { dir, path } = await brainTranscript()
  const profile: BrainExecutionProfile = {
    owner: { kind: 'brain', jobId: 'job-1' },
    cwd: '/isolated',
    agentDir: '/isolated-config',
    sessionDir: dir,
    binaryPath: process.execPath,
    processorExtension: '/audited/brain-processor.ts',
    providerExtension: '/audited/provider.ts',
    provider: 'synthetic',
    modelId: 'exact-model',
  }
  h.serviceRuntime.spawn = vi.fn(async () => ({ sessionId: 'owned', workspacePath: '/isolated' }))
  const lock = vi.spyOn(h.serviceRuntime.paths, 'openSessionPath')
  const options = { workspacePath: '/isolated', sessionPath: path }
  await expect(h.service.create(options, undefined, { brain: profile })).resolves.toMatchObject({
    sessionId: 'owned',
  })
  expect(lock).toHaveBeenCalledExactlyOnceWith(sessionPathKey(path), expect.any(Function))
  expect(h.serviceRuntime.spawn).toHaveBeenCalledExactlyOnceWith(
    { ...options, sessionPath: sessionPathKey(path) },
    undefined,
    expect.objectContaining({ brain: profile }),
  )
  await expect(
    h.service.create(options, undefined, {
      brain: { ...profile, owner: { kind: 'brain', jobId: 'wrong-job' } },
    }),
  ).rejects.toThrow('own persisted job')
  await expect(
    h.service.create(options, undefined, {
      brain: { ...profile, sessionDir: '/not-owned' },
    }),
  ).rejects.toThrow('own persisted job')
})

it('never adopts or disposes a live processor for manual resume even before metadata is persisted', async () => {
  const h = fixture()
  const { dir, path } = await brainTranscript()
  await writeFile(path, JSON.stringify({ type: 'session', id: 'not-yet-marked' }) + '\n')
  const live = await h.service.create({ workspacePath: dir, sessionPath: path })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job-1' } })
  await expect(h.service.create({ workspacePath: dir, sessionPath: path })).rejects.toThrow('Brain')
  await expect(h.service.dispose(live.sessionId)).rejects.toThrow('Brain')
  expect(h.clients[0]!.dispose).not.toHaveBeenCalled()
})

it('keeps all read-only RPC inspection available and refuses future get_* by default', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  const client = h.clients[0]!
  client.request.mockClear()
  for (const type of [
    'get_state',
    'get_messages',
    'get_session_stats',
    'get_available_models',
    'get_available_thinking_levels',
    'get_commands',
    'get_entries',
    'get_tree',
    'get_fork_messages',
    'get_last_assistant_text',
  ] as const)
    await h.service.command(live.sessionId, { type })
  expect(client.request).toHaveBeenCalledTimes(10)
  await expect(
    h.service.command(live.sessionId, { type: 'get_future_mutation' } as unknown as RpcCommand),
  ).rejects.toThrow('Brain')
  expect(client.request).toHaveBeenCalledTimes(10)
})

it('allows trusted disposal only with the matching Brain job owner, never as a routine', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  const owner = { kind: 'brain', jobId: 'job' } as const
  await expect(h.service.disposeBrain(live.sessionId, owner)).rejects.toThrow(
    'matching processor job',
  )
  Object.assign(h.registry.get(live.sessionId)!, { owner })
  await expect(
    h.service.disposeBrain(live.sessionId, { ...owner, jobId: 'different' }),
  ).rejects.toThrow('matching processor job')
  expect(h.clients[0]!.dispose).not.toHaveBeenCalled()
  await h.service.disposeBrain(live.sessionId, owner)
  expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
  expect(h.serviceRuntime.routines.cancel).not.toHaveBeenCalled()
  await expect(h.service.disposeBrain(live.sessionId, owner)).resolves.toBeUndefined()
})

it('blocks relative paths and live unmarked processor sources from manual fork/switch', async () => {
  const h = fixture()
  const { dir, path } = await brainTranscript()
  await expect(
    h.service.create({ workspacePath: dir, forkFrom: './processor.jsonl' }),
  ).rejects.toThrow('Brain')
  await writeFile(path, JSON.stringify({ type: 'session', id: 'unmarked' }) + '\n')
  const live = await h.service.create({ workspacePath: dir, sessionPath: path })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  await expect(
    h.service.create({ workspacePath: dir, forkFrom: './processor.jsonl' }),
  ).rejects.toThrow('Brain')
  const ordinary = await h.service.create({ workspacePath: dir })
  await expect(
    h.service.command(ordinary.sessionId, {
      type: 'switch_session',
      sessionPath: './processor.jsonl',
    }),
  ).rejects.toThrow('Brain')
})
