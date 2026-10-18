import { PiUnavailableError, resolvePiInvoker } from './invoker'
import { runPrintMode } from './print-mode'
import {
  CLAUDE_TITLE_FALLBACK,
  dedupeTitle,
  sanitizeTitle,
  titleArgs,
  titleAttempts,
  titlePrompt,
  type TitleAttempt,
} from './session-naming'
import { modelKey, planTitleRun, rememberTitleFailures, type TitleMemory } from './title-plan'
import { claudeAccountEnv, primaryAccount } from '../claude/accounts'
import { claudeOneShotEnv, claudeProviderSpawnEnv, usesClaudeCliProvider } from './provider-detect'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { getLanePrefs } from '../store'
import { log } from '../debug-log'

// Preserve the original per-app-launch learning across all IPC registrations.
const titleMemory: TitleMemory = {
  fullBootProviders: new Set(),
  unusableTitleModels: new Set(),
}

interface PreparedTitle {
  binaryPath: string
  prefixArgs: string[]
  env: NodeJS.ProcessEnv
  workspacePath: string
  defaultProvider: string | undefined
  plan: TitleAttempt[]
  prompt: string
  maxLength: number
}

interface TitleResult {
  title: string | null
  errors: string[]
  used: TitleAttempt | undefined
}

async function prepare(
  workspacePath: string,
  message: string,
  existingNames: string[],
): Promise<PreparedTitle | null> {
  const lanePrefs = getLanePrefs()
  const invoker = await resolvePiInvoker('inherited-stub').catch((error: unknown) => {
    if (error instanceof PiUnavailableError) return null
    throw error
  })
  if (!invoker) return null
  const { binaryPath, prefixArgs, stub } = invoker
  const env = stub
    ? invoker.env
    : {
        ...process.env,
        ...invoker.env,
        // Match sessions' pi ownership; one-shot runs must exit after answering.
        ...claudeProviderSpawnEnv(),
        ...claudeOneShotEnv(),
      }

  // `--no-session` keeps this run out of the sidebar; `--no-tools`
  // keeps a title request from being able to touch anything; the rest of
  // `titleArgs` keeps a five-word title from paying for a full session's
  // context. Spawned through runPrintMode because `pi -p` blocks until
  // stdin hits EOF — see electron/pi/print-mode.ts, and never
  // reintroduce execFile here.
  const settings: { defaultProvider?: string; defaultModel?: string } = stub
    ? {}
    : await readAgentSettings(workspacePath)
  const claudeCli = stub ? false : usesClaudeCliProvider({}, settings.defaultProvider)
  const fallback = claudeCli ? CLAUDE_TITLE_FALLBACK : null
  const plan = stub
    ? titleAttempts(null, null, null)
    : await planTitleRun(titleMemory, workspacePath, settings, fallback)
  // A naming run bills a plan too, so it goes to the account the user
  // pinned (or the first one) rather than to whatever the CLI's default
  // keychain entry happens to hold. Only asked for on the Claude path:
  // resolving it costs two `claude` spawns on an install that has never
  // stored an account, and a title run is on the session-start path.
  if (claudeCli) {
    Object.assign(env, claudeAccountEnv(await primaryAccount().catch(() => null)))
  }
  const prompt = titlePrompt(message, existingNames, {
    min: lanePrefs.nameMinWords,
    max: lanePrefs.nameMaxWords,
  })
  return {
    binaryPath,
    prefixArgs,
    env,
    workspacePath,
    plan,
    prompt,
    defaultProvider: settings.defaultProvider,
    maxLength: lanePrefs.nameMaxLength,
  }
}

async function executeAttempts(context: PreparedTitle): Promise<TitleResult> {
  let title: string | null = null
  const errors: string[] = []
  for (const attempt of context.plan) {
    const { stdout, error } = await runPrintMode(
      context.binaryPath,
      [...context.prefixArgs, ...titleArgs(attempt), context.prompt],
      { cwd: context.workspacePath, env: context.env },
    )
    title = stdout ? sanitizeTitle(stdout, context.maxLength) : null
    if (title) break
    errors.push(error ?? 'empty reply')
    // A timeout is not a boot or model problem; another run would only
    // spend another 30s.
    if (error?.startsWith('timed out')) break
  }
  return { title, errors, used: title ? context.plan[errors.length] : undefined }
}

function logResult(result: TitleResult, started: number): void {
  const { title, errors, used } = result
  // One diagnostic per naming run: otherwise failures have no visible symptom.
  log('naming', title ? 'generated a session name' : 'no session name', {
    ms: Date.now() - started,
    title,
    model: used?.model ? modelKey(used.model) : 'default',
    fastBoot: Boolean(used?.extensions),
    ...(errors.length ? { errors } : {}),
  })
}

/** Best-effort naming; failed attempts leave the first-message-derived title. */
export async function generateSessionTitle(
  workspacePath: string,
  message: string,
  existingNames: string[],
): Promise<string | null> {
  const context = await prepare(workspacePath, message, existingNames)
  if (!context) return null
  const started = Date.now()
  const result = await executeAttempts(context)
  if (result.used) {
    rememberTitleFailures(
      titleMemory,
      context.plan.slice(0, result.errors.length),
      result.used,
      context.defaultProvider,
    )
  }
  logResult(result, started)
  return result.title ? dedupeTitle(result.title, existingNames) : null
}
