import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareBrainSpawnOptions,
  verifyBrainModel,
  type BrainExecutionProfile,
} from './brain-execution-profile'
import { PiRpcClient } from './rpc-client'
import { prepareSessionPolicy, type SessionPolicyRuntime } from './session-policy'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brain-profile-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const profile: BrainExecutionProfile = {
    owner: { kind: 'brain', jobId: 'job-1' },
    cwd: join(root, 'cwd'),
    agentDir: join(root, 'config'),
    sessionDir: join(root, 'sessions'),
    binaryPath: process.execPath,
    processorExtension: join(root, 'brain-processor.ts'),
    providerExtension: join(root, 'audited-provider.ts'),
    provider: 'synthetic',
    modelId: 'exact-model',
    env: { PATH: '/explicit-path', PHOSPHOR_BRAIN_TOKEN: 'ephemeral-token' },
  }
  await Promise.all([profile.cwd, profile.agentDir, profile.sessionDir].map((dir) => mkdir(dir)))
  return { profile, options: { workspacePath: profile.cwd } }
}

it('passes the exact restricted argv and only the explicit environment to a subprocess', async () => {
  const { profile, options } = await fixture()
  const spawnOptions = await prepareBrainSpawnOptions(options, profile)
  const probe =
    "process.stderr.write(JSON.stringify({args:process.argv.slice(1),env:process.env})+'\\n');process.stdin.resume()"
  const client = new PiRpcClient(
    {
      ...spawnOptions,
      cwd: profile.cwd,
      prefixArgs: ['-e', probe, '--'],
    },
    { log: vi.fn(), isClosing: () => false },
  )
  cleanups.push(() => client.dispose())
  const seen = new Promise<{ args: string[]; env: Record<string, string> }>((resolve) => {
    client.once('stderr', (line) => resolve(JSON.parse(line)))
  })
  client.spawn()
  const result = await seen
  expect(result.args).toEqual([
    '--mode',
    'rpc',
    '--model',
    'exact-model',
    '--provider',
    'synthetic',
    '--offline',
    '--no-approve',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-themes',
    '--no-builtin-tools',
    '--tools',
    'brain_job,brain_propose',
    '--exclude-tools',
    'mcp__*',
    '--session-dir',
    profile.sessionDir,
    '-e',
    profile.processorExtension,
    '-e',
    profile.providerExtension,
  ])
  // macOS/libuv supplies this encoding marker even with a replacement environment.
  if (process.platform === 'darwin') delete result.env.__CF_USER_TEXT_ENCODING
  expect(result.env).toEqual({
    PATH: '/explicit-path',
    PHOSPHOR_BRAIN_TOKEN: 'ephemeral-token',
    HOME: profile.cwd,
    PI_CODING_AGENT_DIR: profile.agentDir,
    PI_CODING_AGENT_SESSION_DIR: profile.sessionDir,
    PHOSPHOR_BRAIN_JOB_ID: 'job-1',
  })
  expect(spawnOptions).toMatchObject({ ownProcessGroup: true, inheritEnv: false })
})

it('bypasses every ordinary policy dependency, even if they would fail or mutate global config', async () => {
  const { profile, options } = await fixture()
  const forbidden = vi.fn(() => {
    throw new Error('ordinary policy must not run')
  })
  const runtime: SessionPolicyRuntime = {
    machineContext: forbidden,
    git: forbidden,
    preferences: forbidden,
    defaultProvider: forbidden,
    packages: forbidden,
    account: forbidden,
    compressionEnvironment: forbidden,
    resetCompaction: forbidden,
  }
  const result = await prepareSessionPolicy(
    options,
    { brain: profile },
    {
      stub: false,
      env: { PRIVATE_AMBIENT: 'do not inherit' },
      extensions: ['/untrusted.ts'],
    },
    runtime,
  )
  expect(forbidden).not.toHaveBeenCalled()
  expect(result.spawnOptions.env).not.toHaveProperty('PRIVATE_AMBIENT')
  expect(result.spawnOptions).not.toHaveProperty('appendSystemPrompt')
  expect(result.spawnOptions).not.toHaveProperty('noSession')
  expect(result.spawnOptions.extensions).toEqual([
    profile.processorExtension,
    profile.providerExtension,
  ])
})

describe('Brain profile fail-closed validation', () => {
  it.each([
    'NODE_OPTIONS',
    'CLAUDE_CONFIG_DIR',
    'PI_CLAUDE_CLI_CONTEXT',
    'PI_CODING_AGENT_DIR',
    'HOME',
    'HTTPS_PROXY',
  ])('rejects an unapproved %s environment override', async (key) => {
    const { profile, options } = await fixture()
    profile.env = { [key]: 'not-allowed' }
    await expect(prepareBrainSpawnOptions(options, profile)).rejects.toThrow(
      'Unsupported Brain environment key',
    )
  })
  it('requires empty config/cwd, distinct directories, absolute audited resources and matching options', async () => {
    const { profile, options } = await fixture()
    for (const field of [
      'cwd',
      'agentDir',
      'sessionDir',
      'binaryPath',
      'processorExtension',
      'providerExtension',
    ] as const) {
      await expect(
        prepareBrainSpawnOptions(options, { ...profile, [field]: 'relative' }),
      ).rejects.toThrow('absolute')
    }
    await expect(
      prepareBrainSpawnOptions(options, { ...profile, agentDir: profile.cwd }),
    ).rejects.toThrow('distinct')
    await expect(
      prepareBrainSpawnOptions({ ...options, forkFrom: '/source' }, profile),
    ).rejects.toThrow('cannot fork')
    await expect(prepareBrainSpawnOptions({ workspacePath: '/repo' }, profile)).rejects.toThrow(
      'isolated cwd',
    )
    await expect(
      prepareBrainSpawnOptions({ ...options, model: 'different' }, profile),
    ).rejects.toThrow('trusted model')
    await writeFile(join(profile.cwd, 'AGENTS.md'), 'untrusted instructions')
    await expect(prepareBrainSpawnOptions(options, profile)).rejects.toThrow(
      'working directory must be empty',
    )
    await rm(join(profile.cwd, 'AGENTS.md'))
    await writeFile(join(profile.agentDir, 'settings.json'), '{}')
    await expect(prepareBrainSpawnOptions(options, profile)).rejects.toThrow(
      'config directory must be empty',
    )
  })
  it('refuses unsupported shared OAuth and Claude, rather than falling back to another provider', async () => {
    const { profile, options } = await fixture()
    await expect(
      prepareBrainSpawnOptions(options, {
        ...profile,
        provider: 'openai-codex',
        providerExtension: undefined,
      }),
    ).rejects.toThrow('shared OAuth is not imported')
    await expect(
      prepareBrainSpawnOptions(options, {
        ...profile,
        provider: 'pi-claude-cli',
      }),
    ).rejects.toThrow('internal MCP bridge')
    await expect(
      prepareBrainSpawnOptions(options, {
        ...profile,
        env: { PHOSPHOR_BRAIN_JOB_ID: 'different-job' },
      }),
    ).rejects.toThrow('does not match')
  })
  it.each(['anthropic', 'openai'])(
    'supports explicitly supplied native %s credentials without shared config',
    async (provider) => {
      const { profile, options } = await fixture()
      const key = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
      const prepared = await prepareBrainSpawnOptions(options, {
        ...profile,
        provider,
        providerExtension: undefined,
        env: { [key]: 'synthetic-not-real' },
      })
      expect(prepared.extensions).toEqual([profile.processorExtension])
      expect(prepared.env?.[key]).toBe('synthetic-not-real')
    },
  )
})

it('verifies exact resolved model identity, including missing/error state', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ success: true, data: { model: { provider: 'p', id: 'id' } } })
  const client = { request } as unknown as Pick<PiRpcClient, 'request'>
  await expect(verifyBrainModel(client, { provider: 'p', modelId: 'id' })).resolves.toBeUndefined()
  for (const data of [
    { model: { provider: 'other', id: 'id' } },
    { model: { provider: 'p', id: 'id-alias' } },
    {},
    undefined,
  ]) {
    request.mockResolvedValue({ success: true, data })
    await expect(verifyBrainModel(client, { provider: 'p', modelId: 'id' })).rejects.toThrow(
      'readiness failed',
    )
  }
  request.mockResolvedValue({ success: false, error: 'no model' })
  await expect(verifyBrainModel(client, { provider: 'p', modelId: 'id' })).rejects.toThrow(
    'readiness failed',
  )
})
