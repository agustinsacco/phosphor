import { expect, it } from 'vitest'
import type { PiRpcClient } from './rpc-client'
import {
  learningSpawnArgs,
  prepareLearningSpawnOptions,
  type LearningExecutionProfile,
} from './learning-execution-profile'
const profile: LearningExecutionProfile = {
  owner: { kind: 'brain', jobId: 'job' },
  cwd: '/private/job/cwd',
  sessionDir: '/private/job/control',
  agentDir: '/pi/agent',
  binaryPath: '/bin/pi',
  carrierExtension: '/resources/brain-learning-carrier.mjs',
  controlFile: '/private/job/control.json',
  nonce: 'a'.repeat(64),
  provider: 'openai',
  modelId: 'exact',
  thinkingLevel: 'high',
  env: { PATH: '/bin', HOME: '/home/test' },
}
it('keeps the learning profile separate from API-key-only Brain, shares auth by reference and disables executors/discovery only', () => {
  const spawn = prepareLearningSpawnOptions({ workspacePath: profile.cwd }, profile)
  expect(spawn).toMatchObject({
    inheritEnv: false,
    ownProcessGroup: true,
    provider: 'openai',
    model: 'exact',
    env: { HOME: '/home/test', PI_CODING_AGENT_DIR: '/pi/agent' },
    learningSessionDir: profile.sessionDir,
  })
  expect(spawn.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  const args = learningSpawnArgs(profile.sessionDir)
  expect(args).toEqual(
    expect.arrayContaining([
      '--no-builtin-tools',
      '--no-mcp',
      '--no-extensions',
      '--exclude-tools',
      '*',
    ]),
  )
  expect(args).not.toContain('--no-hooks')
  expect(args).not.toContain('brain_job,brain_propose')
})
it('refuses ambient credential overrides, native fork/resume and resource substitution', () => {
  for (const env of [
    { OPENAI_API_KEY: 'not-a-real-secret' },
    { PI_MODEL: 'fallback' },
    { NODE_OPTIONS: '--import=bad' },
  ] as Array<Record<string, string>>) {
    expect(() =>
      prepareLearningSpawnOptions({ workspacePath: profile.cwd }, { ...profile, env }),
    ).toThrow()
  }
  expect(() =>
    prepareLearningSpawnOptions({ workspacePath: profile.cwd, forkFrom: '/source' }, profile),
  ).toThrow()
  expect(() =>
    prepareLearningSpawnOptions({ workspacePath: profile.cwd, sessionPath: '/source' }, profile),
  ).toThrow()
  expect(() =>
    prepareLearningSpawnOptions(
      { workspacePath: profile.cwd },
      { ...profile, carrierExtension: '/bad.ts' },
    ),
  ).toThrow()
})

it('caps total learning stdout/stderr before JSONL accumulation, without changing ordinary framing', async () => {
  const { learningOutputGuard } = await import('./learning-execution-profile')
  let stopped = 0
  const guard = learningOutputGuard(true, () => {
    stopped++
  })
  expect(guard(Buffer.alloc(1_000_000))).toBe(true)
  expect(guard(Buffer.alloc(1_000_000))).toBe(true)
  expect(guard(Buffer.from('overflow'))).toBe(false)
  expect(stopped).toBe(1)
  expect(
    learningOutputGuard(false, () => {
      throw new Error('ordinary regression')
    })(Buffer.alloc(2_000_001)),
  ).toBe(true)
})
it('guards startup events before a private process can publish ordinary agent work', async () => {
  const { EventEmitter } = await import('node:events')
  const { vi } = await import('vitest')
  const { guardLearningExecution } = await import('./learning-execution-profile')
  const client = Object.assign(new EventEmitter(), {
    dispose: vi.fn(async () => {}),
    killNow: vi.fn(),
  })
  const verify = guardLearningExecution(client as unknown as PiRpcClient)
  verify()
  client.emit('event', { type: 'agent_start' })
  expect(verify).toThrow('agent/tool/retry/compaction')
  expect(client.dispose).toHaveBeenCalledExactlyOnceWith(0)
  client.emit('exit', {})
  expect(client.listenerCount('event')).toBe(0)
})
it('cannot attach an existing same-job processor through the early live-session reuse path', async () => {
  const { sessionFixture } = await import('./__fixtures__/session-runtime')
  const { createSessionService } = await import('./session-service')
  const { createSessionPathRuntime } = await import('./session-path-lock')
  const h = sessionFixture()
  const live = h.registry.create(
    profile.cwd,
    { sessionPath: '/synthetic/source.jsonl' },
    profile.owner,
  )
  const service = createSessionService({
    registry: h.registry,
    paths: createSessionPathRuntime(),
    spawn: async () => {
      throw new Error('Must not spawn')
    },
    isStub: () => true,
    packages: async () => [],
    readBudget: () => '200k',
    withBudgetCompaction: async (_id, _type, run) => run(),
    forgetAccount: () => {},
    routines: {
      owns: () => false,
      sessionForPath: () => undefined,
      observe: () => {},
      cancel: async () => {},
    },
  })
  await expect(
    service.create(
      { workspacePath: profile.cwd, sessionPath: '/synthetic/source.jsonl' },
      undefined,
      { learning: profile },
    ),
  ).rejects.toThrow('fresh private control')
  expect(h.registry.get(live.sessionId)?.owner).toEqual(profile.owner)
  await h.registry.disposeAll()
})
