import type { AppPrefs, CreateSessionOptions, GitInfo, PiPackageEntry } from '@shared/models'
import { CONTEXT_FILES_ENV, contextFilesEnvValue } from '@shared/context-files'
import type { MachineContext } from './machine-prompt'
import { composeDirectives } from './directives'
import { prepareProviderAccount } from './session-provider'
import type { PiSpawnOptions } from './rpc-client'
import type { prepareSessionLaunch } from './session-launch'

export interface SessionExecution {
  unattended?: boolean
  intent?: 'report' | 'code'
  signal?: AbortSignal
}

/** Machine-local inputs. These are trusted dependencies, never remote spawn options. */
export interface SessionPolicyRuntime {
  machineContext: () => MachineContext | Promise<MachineContext>
  git: (cwd: string) => Promise<GitInfo>
  preferences: () => Pick<AppPrefs, 'agentDirectives' | 'agentDirectivesByProject'> &
    Partial<Pick<AppPrefs, 'contextFiles'>>
  defaultProvider: (cwd: string) => Promise<string | undefined>
  packages: (cwd: string) => Promise<Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[]>
  account: (options: { sessionPath?: string }) => Promise<{
    id: string
    env: Record<string, string>
  } | null>
  /** Hosts must not silently bill the default credential when configured account metadata fails. */
  strictAccountSelection?: boolean
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
    machine: await runtime.machineContext(),
    ...(git.isWorktree && git.branch && execution.intent !== 'report'
      ? { charter: { branch: git.branch } }
      : {}),
  })
  const account = await prepareProviderAccount(options, stub, runtime)
  if (account) Object.assign(env, account.env)
  if (!stub) Object.assign(env, runtime.compressionEnvironment())
  // The lane's starting state for the bundled context-files filter, from an
  // owner that has the preference (Desktop). Absent when every file is sent,
  // so an inherited value cannot leak in. Unattended runs (routines) always
  // send the project's rules: the composer checkboxes are for interactive
  // lanes. An owner without the preference (the Host) keeps its environment
  // exactly as it built it.
  if (!stub && prefs.contextFiles) {
    const value = execution.unattended ? undefined : contextFilesEnvValue(prefs.contextFiles)
    if (value) env[CONTEXT_FILES_ENV] = value
    else delete env[CONTEXT_FILES_ENV]
  }
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
