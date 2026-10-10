import type { AppPrefs, CreateSessionOptions, GitInfo, PiPackageEntry } from '@shared/models'
import { CONTEXT_FILES_ENV, contextFilesEnvValue } from '@shared/context-files'
import { composeDirectives } from './directives'
import { assertClaudeContextProvider, usesClaudeCliProvider } from './provider-detect'
import type { PiSpawnOptions } from './rpc-client'
import type { prepareSessionLaunch } from './session-launch'

export interface SessionExecution {
  unattended?: boolean
  intent?: 'report' | 'code'
  signal?: AbortSignal
}

/** Machine-local inputs. These are trusted dependencies, never remote spawn options. */
export interface SessionPolicyRuntime {
  git: (cwd: string) => Promise<GitInfo>
  preferences: () => Pick<AppPrefs, 'agentDirectives' | 'agentDirectivesByProject'> &
    Partial<Pick<AppPrefs, 'contextFiles'>>
  defaultProvider: (cwd: string) => Promise<string | undefined>
  packages: (cwd: string) => Promise<Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[]>
  account: (options: { sessionPath?: string }) => Promise<{
    id: string
    env: Record<string, string>
  } | null>
  compressionEnvironment: () => Record<string, string>
  resetCompaction: () => Promise<void>
}

/** Resolve the policy once for a spawn; budget and ownership remain live elsewhere. */
export async function prepareSessionPolicy(
  options: CreateSessionOptions,
  execution: SessionExecution,
  launch: Awaited<ReturnType<typeof prepareSessionLaunch>>,
  runtime: SessionPolicyRuntime,
): Promise<{ spawnOptions: Omit<PiSpawnOptions, 'cwd'>; accountId?: string }> {
  const { stub, binaryPath, prefixArgs, extensions } = launch
  const env = { ...launch.env }
  const git = stub ? { isRepo: false } : await runtime.git(options.workspacePath)
  const projectKey = git.mainRepoPath ?? options.workspacePath
  const prefs = runtime.preferences()
  const directivePrefs = prefs.agentDirectivesByProject[projectKey] ?? prefs.agentDirectives
  const appendSystemPrompt = composeDirectives({
    cwd: options.workspacePath,
    git,
    prefs: directivePrefs,
    ...(git.isWorktree && git.branch && execution.intent !== 'report'
      ? { charter: { branch: git.branch } }
      : {}),
  })
  // Conservative prediction here; command admission also checks the resolved model.
  const claudeProvider = stub
    ? false
    : usesClaudeCliProvider(options, await runtime.defaultProvider(options.workspacePath))
  if (claudeProvider) assertClaudeContextProvider(await runtime.packages(options.workspacePath))
  // Credential selection is fixed for the process lifetime, including resumed sessions.
  const account = claudeProvider
    ? await runtime
        .account(options.sessionPath ? { sessionPath: options.sessionPath } : {})
        .catch(() => null)
    : null
  if (account) Object.assign(env, account.env)
  if (!stub) Object.assign(env, runtime.compressionEnvironment())
  // The lane's starting state for the bundled context-files filter. Always
  // set, so a value inherited from Phosphor's own environment cannot leak in.
  if (!stub)
    env[CONTEXT_FILES_ENV] = prefs.contextFiles
      ? (contextFilesEnvValue(prefs.contextFiles) ?? '')
      : ''
  // pi reads its settings at process startup, so this must complete before create().
  if (!stub) await runtime.resetCompaction()
  return {
    accountId: account?.id,
    spawnOptions: {
      ownProcessGroup: true,
      binaryPath,
      prefixArgs,
      sessionPath: options.sessionPath,
      forkFrom: options.forkFrom,
      name: options.name,
      model: options.model,
      provider: options.provider,
      thinkingLevel: options.thinkingLevel,
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(stub ? {} : { extensions }),
      env,
    },
  }
}
