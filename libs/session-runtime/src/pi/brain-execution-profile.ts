import { readdir } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { CreateSessionOptions } from '@shared/models'
import type { PiRpcClient, PiSpawnOptions } from './rpc-client'
import type { BrainSessionOwner } from './brain-session-owner'
import { sessionPathKey } from './session-path-lock'

/**
 * Trusted machine-local capability, never accepted over renderer/Host IPC.
 * The binding gates pi >=1.4.0 (the probed version), audits provider tools and
 * owns the whole-job deadline/cancellation through execution.signal and disposeBrain.
 */
export interface BrainExecutionProfile {
  owner: BrainSessionOwner
  /** Existing empty working directory, unrelated to a user's workspace. */
  cwd: string
  /** Dedicated config directory; no settings, models, packages or shared auth. */
  agentDir: string
  /** Dedicated persistent transcript directory. */
  sessionDir: string
  /** Audited executable and, when needed, interpreter entry point. */
  binaryPath: string
  prefixArgs?: string[]
  provider: string
  modelId: string
  /** Absolute path to the audited source or standalone bundled processor resource. */
  processorExtension: string
  /** Optional explicitly audited provider registration, never ambient discovery. */
  providerExtension?: string
  /** Only BRAIN_ENVIRONMENT_KEYS are admitted; all other keys fail closed. */
  env?: Record<string, string>
}

export const BRAIN_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'PHOSPHOR_BRAIN_ENDPOINT',
  'PHOSPHOR_BRAIN_TOKEN',
  'PHOSPHOR_BRAIN_JOB_ID',
])

/** Fixed allowlist plus explicit MCP exclusion: --tools alone retains MCP tools. */
export function brainSpawnArgs(sessionDir: string): string[] {
  return [
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
    sessionDir,
  ]
}

function validateProfile(profile: BrainExecutionProfile, options: CreateSessionOptions): void {
  for (const path of [
    profile.cwd,
    profile.agentDir,
    profile.sessionDir,
    profile.binaryPath,
    profile.processorExtension,
    ...(profile.providerExtension ? [profile.providerExtension] : []),
  ]) {
    if (!isAbsolute(path))
      throw new Error('Brain resources and isolated directories must be absolute.')
  }
  if (new Set([profile.cwd, profile.agentDir, profile.sessionDir].map(sessionPathKey)).size !== 3)
    throw new Error('Brain working, config and transcript directories must be distinct.')
  if (sessionPathKey(options.workspacePath) !== sessionPathKey(profile.cwd) || options.forkFrom)
    throw new Error('Brain execution requires its isolated cwd and cannot fork a user session.')
  if (!['brain-processor.ts', 'brain-processor.mjs'].includes(basename(profile.processorExtension)))
    throw new Error('Brain execution requires the audited brain-processor.ts resource or bundle.')
  if (profile.owner.kind !== 'brain' || !profile.owner.jobId.trim())
    throw new Error('Brain execution requires a job owner.')
  if (!profile.provider || !profile.modelId)
    throw new Error('Brain execution requires an exact provider and model id.')
  if (
    (options.provider && options.provider !== profile.provider) ||
    (options.model && options.model !== profile.modelId)
  )
    throw new Error('Brain session options must match the trusted model selection.')
  if (profile.provider === 'pi-claude-cli')
    throw new Error(
      'Brain Claude execution is unsupported until its internal MCP bridge is audited.',
    )
  for (const key of Object.keys(profile.env ?? {})) {
    if (!BRAIN_ENVIRONMENT_KEYS.includes(key))
      throw new Error(`Unsupported Brain environment key: ${key}`)
  }
  if (
    profile.env?.PHOSPHOR_BRAIN_JOB_ID &&
    profile.env.PHOSPHOR_BRAIN_JOB_ID !== profile.owner.jobId
  )
    throw new Error('Brain bridge job does not match the session owner.')
  if (
    !profile.providerExtension &&
    !(
      (profile.provider === 'anthropic' && profile.env?.ANTHROPIC_API_KEY) ||
      (profile.provider === 'openai' && profile.env?.OPENAI_API_KEY)
    )
  )
    throw new Error(
      'Brain provider credentials are unavailable in isolated config. An explicit supported credential source is required; shared OAuth is not imported.',
    )
}

/** No workspace directives, account routing, global config repair or ambient environment. */
export async function prepareBrainSpawnOptions(
  options: CreateSessionOptions,
  profile: BrainExecutionProfile,
): Promise<Omit<PiSpawnOptions, 'cwd'>> {
  validateProfile(profile, options)
  if ((await readdir(profile.cwd)).length) throw new Error('Brain working directory must be empty.')
  // Use fresh config per process, including transcript resume. Never clone settings or OAuth.
  if ((await readdir(profile.agentDir)).length)
    throw new Error(
      'Brain config directory must be empty; shared settings and credentials are unsupported.',
    )
  return {
    binaryPath: profile.binaryPath,
    prefixArgs: profile.prefixArgs,
    ownProcessGroup: true,
    inheritEnv: false,
    env: {
      ...profile.env,
      HOME: profile.cwd,
      PI_CODING_AGENT_DIR: profile.agentDir,
      PI_CODING_AGENT_SESSION_DIR: profile.sessionDir,
      PHOSPHOR_BRAIN_JOB_ID: profile.owner.jobId,
    },
    brainSessionDir: profile.sessionDir,
    sessionPath: options.sessionPath,
    provider: profile.provider,
    model: profile.modelId,
    extensions: [
      profile.processorExtension,
      ...(profile.providerExtension ? [profile.providerExtension] : []),
    ],
  }
}

/** CLI model patterns are not identity enforcement; check before every job, including resume. */
export async function verifyBrainModel(
  client: Pick<PiRpcClient, 'request'>,
  profile: Pick<BrainExecutionProfile, 'provider' | 'modelId'>,
): Promise<void> {
  const state = await client.request({ type: 'get_state' })
  if (
    !state.success ||
    state.data?.model?.provider !== profile.provider ||
    state.data.model.id !== profile.modelId
  )
    throw new Error(
      `Brain model readiness failed: expected exact ${profile.provider}/${profile.modelId}.`,
    )
}
