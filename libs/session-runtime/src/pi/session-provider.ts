import type { CreateSessionOptions } from '@shared/models'
import { assertClaudeContextProvider, usesClaudeCliProvider } from './provider-detect'
import { resumeProvider } from './resume-provider'
import type { SessionPolicyRuntime } from './session-policy'

type ProviderRuntime = Pick<
  SessionPolicyRuntime,
  'defaultProvider' | 'packages' | 'account' | 'strictAccountSelection'
>

/** Predict credentials before spawn; strict startup separately verifies pi's actual fallback. */
export async function prepareProviderAccount(
  options: CreateSessionOptions,
  stub: boolean,
  runtime: ProviderRuntime,
) {
  // Explicit CLI model/provider options take precedence over a saved transcript.
  const restored =
    !stub && options.sessionPath && !options.provider && !options.model
      ? await resumeProvider(options.sessionPath).catch((error: unknown) => {
          if (runtime.strictAccountSelection) throw error
          return undefined
        })
      : undefined
  const claudeProvider = stub
    ? false
    : usesClaudeCliProvider(
        options,
        restored ?? (await runtime.defaultProvider(options.workspacePath)),
      )
  if (claudeProvider) assertClaudeContextProvider(await runtime.packages(options.workspacePath))
  // Fixed for the process lifetime, including resumed sessions.
  return claudeProvider
    ? runtime
        .account(options.sessionPath ? { sessionPath: options.sessionPath } : {})
        .catch((error: unknown) => {
          if (runtime.strictAccountSelection) throw error
          return null
        })
    : null
}
