import { basename, isAbsolute } from 'node:path'
import type { CreateSessionOptions } from '@shared/models'
import type { PiEvent, ThinkingLevel } from '@shared/rpc'
import type { BrainSessionOwner } from './brain-session-owner'
import type { PiRpcClient, PiSpawnOptions } from './rpc-client'
import { sessionPathKey } from './session-path-lock'

/** Trusted local capability, not IPC input. Unlike BrainExecutionProfile, auth stays in pi. */
export interface LearningExecutionProfile {
  owner: BrainSessionOwner
  cwd: string
  sessionDir: string
  /** Existing pi config/auth store, referenced in place; never cloned or harvested. */
  agentDir: string
  binaryPath: string
  prefixArgs?: string[]
  carrierExtension: string
  /** Only the separately qualified Claude provider may be loaded beside the carrier. */
  providerExtension?: string
  controlFile: string
  nonce: string
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
  env: Record<string, string>
}
const ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'ELECTRON_RUN_AS_NODE',
  'PI_MANAGED_INSTALL_ROOT',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'PI_CLAUDE_CLI_CONTEXT',
  'PI_CLAUDE_CLI_KEEPALIVE_MS',
  'PI_CLAUDE_CLI_EPHEMERAL',
])
/** Exclude discovery and execution, not trusted provider/auth/startup/managed-host policy hooks. */
export function learningSpawnArgs(sessionDir: string): string[] {
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
    '',
    '--exclude-tools',
    '*',
    '--session-dir',
    sessionDir,
  ]
}
export function prepareLearningSpawnOptions(
  options: CreateSessionOptions,
  profile: LearningExecutionProfile,
): Omit<PiSpawnOptions, 'cwd'> {
  if (
    options.sessionPath ||
    options.forkFrom ||
    sessionPathKey(options.workspacePath) !== sessionPathKey(profile.cwd)
  )
    throw new Error('Learning requires a fresh private control session, never a source resume/fork')
  if (
    profile.owner.kind !== 'brain' ||
    !/^[\w-]{1,128}$/.test(profile.owner.jobId) ||
    !/^[a-f0-9]{64}$/.test(profile.nonce)
  )
    throw new Error('Learning requires a private job owner and nonce')
  const paths = [
    profile.cwd,
    profile.sessionDir,
    profile.agentDir,
    profile.binaryPath,
    profile.carrierExtension,
    profile.controlFile,
    ...(profile.providerExtension ? [profile.providerExtension] : []),
  ]
  if (
    paths.some((path) => !isAbsolute(path)) ||
    new Set([profile.cwd, profile.sessionDir, profile.agentDir].map(sessionPathKey)).size !== 3
  )
    throw new Error('Learning resources and directories must be absolute and distinct')
  if (
    !['brain-learning-carrier.ts', 'brain-learning-carrier.mjs'].includes(
      basename(profile.carrierExtension),
    )
  )
    throw new Error('Learning requires its dedicated audited carrier resource')
  if (
    !profile.provider ||
    !profile.modelId ||
    (options.provider && options.provider !== profile.provider) ||
    (options.model && options.model !== profile.modelId)
  )
    throw new Error('Learning requires an exact selected provider/model')
  if (profile.providerExtension && profile.provider !== 'pi-claude-cli')
    throw new Error('Learning refuses unaudited provider extensions')
  if (Object.keys(profile.env).some((key) => !ENVIRONMENT_KEYS.has(key)))
    throw new Error(
      'Learning refuses ambient credentials, shell resolution and environment overrides',
    )
  return {
    binaryPath: profile.binaryPath,
    prefixArgs: profile.prefixArgs,
    ownProcessGroup: true,
    inheritEnv: false,
    learningSessionDir: profile.sessionDir,
    provider: profile.provider,
    model: profile.modelId,
    thinkingLevel: profile.thinkingLevel,
    extensions: [
      profile.carrierExtension,
      ...(profile.providerExtension ? [profile.providerExtension] : []),
    ],
    env: {
      ...profile.env,
      PI_CODING_AGENT_DIR: profile.agentDir,
      PI_CODING_AGENT_SESSION_DIR: profile.sessionDir,
      PHOSPHOR_LEARNING_CONTROL: profile.controlFile,
      PHOSPHOR_LEARNING_NONCE: profile.nonce,
      PHOSPHOR_BRAIN_JOB_ID: profile.owner.jobId,
    },
  }
}

/** Total stdout/stderr budget, including unterminated JSONL tails, before decoder allocation. */
export function learningOutputGuard(
  restricted: boolean,
  overflow: () => void,
): (chunk: Buffer) => boolean {
  let bytes = 0,
    exceeded = false
  return (chunk) => {
    if (!restricted) return true
    if (exceeded) return false
    bytes += chunk.byteLength
    if (bytes <= 2_000_000) return true
    exceeded = true
    overflow()
    return false
  }
}

/** Attach before spawn: even startup must not enter the agent loop, execute or compact/retry. */
export function guardLearningExecution(client: PiRpcClient): () => void {
  let violated = false
  const event = (value: PiEvent): void => {
    if (
      !['agent_start', 'tool_execution_start', 'auto_retry_start', 'compaction_start'].includes(
        value.type,
      )
    )
      return
    violated = true
    client.dispose(0).catch(() => client.killNow())
  }
  client.on('event', event)
  client.once('exit', () => client.off('event', event))
  return () => {
    if (violated)
      throw new Error('Learning carrier attempted an agent/tool/retry/compaction operation')
  }
}
