import { PiUnavailableError, resolvePiInvoker } from './invoker'
import { catalogueModels } from './catalogue'
import { CLAUDE_TITLE_FALLBACK, titleAttempts } from '@phosphor/session-runtime/pi/title-policy'
import {
  createTitleMemory,
  modelKey,
  planTitleRun,
  runTitleAttempts,
  titleRunEnv,
  type TitleRunRequest,
  type TitleRunResult,
} from '@phosphor/session-runtime/pi/title-run'
import { claudeAccountEnv, primaryAccount } from '../claude/accounts'
import { usesClaudeCliProvider } from './provider-detect'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { log } from '../debug-log'

// Preserve the original per-app-launch learning across all IPC registrations.
const titleMemory = createTitleMemory()

/**
 * `--no-session` keeps this run out of the sidebar; `--no-tools` keeps a
 * title request from being able to touch anything; the rest of `titleArgs`
 * keeps a five-word title from paying for a full session's context. Spawned
 * through runPrintMode because `pi -p` blocks until stdin hits EOF: never
 * reintroduce execFile here.
 */
async function prepare(
  workspacePath: string,
  message: string,
  existingNames: string[],
): Promise<TitleRunRequest | null> {
  const invoker = await resolvePiInvoker('inherited-stub').catch((error: unknown) => {
    if (error instanceof PiUnavailableError) return null
    throw error
  })
  if (!invoker) return null
  const { binaryPath, prefixArgs, stub } = invoker
  const request = {
    pi: { binaryPath, prefixArgs },
    cwd: workspacePath,
    message,
    existingNames,
    acceptPartial: true,
  }
  if (stub) return { ...request, env: invoker.env, plan: titleAttempts(null, null, null) }
  const settings = await readAgentSettings(workspacePath)
  const claudeCli = usesClaudeCliProvider({}, settings.defaultProvider)
  const plan = await planTitleRun(titleMemory, {
    cwd: workspacePath,
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    catalogue: catalogueModels,
    fallback: claudeCli ? CLAUDE_TITLE_FALLBACK : null,
  })
  // A naming run bills a plan too, so it goes to the account the user
  // pinned (or the first one) rather than to whatever the CLI's default
  // keychain entry happens to hold. Only asked for on the Claude path:
  // resolving it costs two `claude` spawns on an install that has never
  // stored an account, and a title run is on the session-start path.
  const account = claudeCli ? claudeAccountEnv(await primaryAccount().catch(() => null)) : {}
  return {
    ...request,
    // Match sessions' pi ownership; one-shot runs must exit after answering.
    env: titleRunEnv({ ...process.env, ...invoker.env }, account),
    plan,
    memory: titleMemory,
    defaultProvider: settings.defaultProvider,
  }
}

function logResult(result: TitleRunResult, started: number): void {
  const { title, failures, used } = result
  // One diagnostic per naming run: otherwise failures have no visible symptom.
  log('naming', title ? 'generated a session name' : 'no session name', {
    ms: Date.now() - started,
    title,
    model: used?.model ? modelKey(used.model) : 'default',
    fastBoot: Boolean(used?.extensions),
    ...(failures.length ? { errors: failures.map((failure) => failure.error) } : {}),
  })
}

/** Best-effort naming; failed attempts leave the first-message-derived title. */
export async function generateSessionTitle(
  workspacePath: string,
  message: string,
  existingNames: string[],
): Promise<string | null> {
  const request = await prepare(workspacePath, message, existingNames)
  if (!request) return null
  const started = Date.now()
  const result = await runTitleAttempts(request)
  logResult(result, started)
  return result.title
}
