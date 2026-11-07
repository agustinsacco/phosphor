import { expect, it } from 'vitest'
import { learningSpawnArgs, prepareLearningSpawnOptions, type LearningExecutionProfile } from './learning-execution-profile'
const profile: LearningExecutionProfile = {
  owner: { kind: 'brain', jobId: 'job' }, cwd: '/private/job/cwd', sessionDir: '/private/job/control', agentDir: '/pi/agent', binaryPath: '/bin/pi',
  carrierExtension: '/resources/brain-learning-carrier.mjs', controlFile: '/private/job/control.json', nonce: 'a'.repeat(64),
  provider: 'openai', modelId: 'exact', thinkingLevel: 'high', env: { PATH: '/bin', HOME: '/home/test' },
}
it('keeps the learning profile separate from API-key-only Brain, shares auth by reference and disables executors/discovery only', () => {
  const spawn = prepareLearningSpawnOptions({ workspacePath: profile.cwd }, profile)
  expect(spawn).toMatchObject({ inheritEnv: false, ownProcessGroup: true, provider: 'openai', model: 'exact', env: { HOME: '/home/test', PI_CODING_AGENT_DIR: '/pi/agent' }, learningSessionDir: profile.sessionDir })
  expect(spawn.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  const args = learningSpawnArgs(profile.sessionDir)
  expect(args).toEqual(expect.arrayContaining(['--no-builtin-tools', '--no-mcp', '--no-extensions', '--exclude-tools', '*']))
  expect(args).not.toContain('--no-hooks')
  expect(args).not.toContain('brain_job,brain_propose')
})
it('refuses ambient credential overrides, native fork/resume and resource substitution', () => {
  for (const env of [{ OPENAI_API_KEY: 'not-a-real-secret' }, { PI_MODEL: 'fallback' }, { NODE_OPTIONS: '--import=bad' }]) {
    expect(() => prepareLearningSpawnOptions({ workspacePath: profile.cwd }, { ...profile, env })).toThrow()
  }
  expect(() => prepareLearningSpawnOptions({ workspacePath: profile.cwd, forkFrom: '/source' }, profile)).toThrow()
  expect(() => prepareLearningSpawnOptions({ workspacePath: profile.cwd, sessionPath: '/source' }, profile)).toThrow()
  expect(() => prepareLearningSpawnOptions({ workspacePath: profile.cwd }, { ...profile, carrierExtension: '/bad.ts' })).toThrow()
})
