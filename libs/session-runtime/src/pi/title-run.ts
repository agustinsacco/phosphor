/**
 * The one title runner: plans the attempts (fast boot, full boot, fallback
 * model), runs them through `runPrintMode` and learns which setups need the
 * slow path. Callers inject the env (machine, provider and routed account),
 * the catalogue and the print limits; the policy is in `title-policy.ts`.
 */
import { resolvePackagePaths } from './package-resources'
import { listPackages } from './packages'
import { runPrintMode, type PrintModeFailure, type PrintModeOptions } from './print-mode'
import { claudeOneShotEnv, claudeProviderSpawnEnv } from './provider-detect'
import {
  dedupeTitle,
  pickTitleModel,
  sanitizeTitle,
  titleArgs,
  titleAttempts,
  titlePrompt,
  type TitleAttempt,
  type TitleCandidate,
  type TitleModel,
} from './title-policy'

/** Learned only from successful title runs; owned for one app or Host launch. */
export interface TitleMemory {
  fullBootProviders: Set<string>
  unusableTitleModels: Set<string>
}

export function createTitleMemory(): TitleMemory {
  return { fullBootProviders: new Set(), unusableTitleModels: new Set() }
}

export const modelKey = (model: TitleModel): string => `${model.provider}/${model.id}`

const sameModel = (a: TitleModel | null, b: TitleModel | null): boolean =>
  (a ? modelKey(a) : null) === (b ? modelKey(b) : null)

/**
 * Learn from the attempts that failed before `used` succeeded, so a setup
 * that cannot take the fast path pays for the failed run once per launch,
 * not on every lane. Only learned from an eventual success: when everything
 * fails (offline, signed out) there is no telling what was at fault.
 */
export function rememberTitleFailures(
  memory: TitleMemory,
  failed: TitleAttempt[],
  used: TitleAttempt,
  defaultProvider: string | undefined,
): void {
  for (const attempt of failed) {
    if (attempt.extensions && !used.extensions && sameModel(attempt.model, used.model)) {
      memory.fullBootProviders.add(attempt.model?.provider ?? defaultProvider ?? '')
    }
    if (attempt.model && !sameModel(attempt.model, used.model)) {
      memory.unusableTitleModels.add(modelKey(attempt.model))
    }
  }
}

/** How long a title waits for a cold model catalogue before using the default. */
const CATALOGUE_WAIT_MS = 4_000

export interface TitlePlanRequest {
  cwd: string
  /** The model the session runs on, or the settings default. */
  provider: string | undefined
  model: string | undefined
  catalogue(): Promise<TitleCandidate[]>
  /** The last attempt's model; null is pi's own default. */
  fallback: TitleModel | null
  agentDir?: string
}

/**
 * Which model to title on, and whether a fast `-ne` boot is possible.
 *
 * The provider's own extension is loaded on a fast boot for the one extension
 * provider Phosphor knows (pi-claude-cli); any other provider gets a bare
 * `-ne`, and `titleAttempts` retries with a full boot if it was not built in.
 */
export async function planTitleRun(
  memory: TitleMemory,
  request: TitlePlanRequest,
): Promise<TitleAttempt[]> {
  const catalogue = await Promise.race([
    request.catalogue().catch(() => []),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), CATALOGUE_WAIT_MS)),
  ])
  const picked = pickTitleModel(catalogue, request.provider, request.model)
  const model =
    picked && !memory.unusableTitleModels.has(modelKey(picked)) ? picked : request.fallback
  const provider = model?.provider ?? request.provider ?? ''
  let fast: string[] | null = memory.fullBootProviders.has(provider) ? null : []
  if (fast && provider === 'pi-claude-cli') {
    const pkg = (await listPackages(request.cwd, request.agentDir).catch(() => [])).find(
      (entry) => entry.name === '@saccolabs/pi-claude-cli' && entry.installed,
    )
    // Package resources are display names, not executable extension paths.
    const extensions = pkg?.installPath ? resolvePackagePaths(pkg.installPath).extensions : []
    fast = extensions.length ? extensions : null
  }
  return titleAttempts(model, fast, request.fallback)
}

/**
 * A naming run's env: the caller's base (machine or process env), pi owning
 * the Claude context as sessions do, one-shot exit, then the account the
 * run bills (the lane's routed account on a Host).
 */
export function titleRunEnv(
  base: NodeJS.ProcessEnv,
  account: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...base, ...claudeProviderSpawnEnv(), ...claudeOneShotEnv(), ...account }
}

/** A fixed token for why one attempt gave no title; never the output itself. */
export type TitleFailure = PrintModeFailure | 'empty'

export interface TitleRunRequest {
  pi: { binaryPath: string; prefixArgs: string[] }
  cwd: string
  env: NodeJS.ProcessEnv
  message: string
  existingNames: string[]
  plan: TitleAttempt[]
  /** Learns from a success when set; the provider the plan defaulted to. */
  memory?: TitleMemory
  defaultProvider?: string
  /** Desktop titles from what a timed-out or aborted attempt printed; a Host discards it. */
  acceptPartial?: boolean
  print?: Pick<PrintModeOptions, 'timeoutMs' | 'signal' | 'stderr' | 'maxOutputBytes' | 'overflow'>
}

export interface TitleRunResult {
  /** Sanitized and deduplicated against `existingNames`. */
  title: string | null
  /** One per failed attempt, in order. `error` may hold stderr: never log it on a Host. */
  failures: { reason: TitleFailure; error: string }[]
  used?: TitleAttempt
}

/**
 * Run the plan until one attempt yields a title. A timeout or abort ends the
 * run: it is not a boot or model problem, and another run would only spend
 * another 30s.
 */
export async function runTitleAttempts(request: TitleRunRequest): Promise<TitleRunResult> {
  const prompt = titlePrompt(request.message, request.existingNames)
  const failures: TitleRunResult['failures'] = []
  for (const attempt of request.plan) {
    const { stdout, error, reason } = await runPrintMode(
      request.pi.binaryPath,
      [...request.pi.prefixArgs, ...titleArgs(attempt), prompt],
      { cwd: request.cwd, env: request.env, ...request.print },
    )
    const usable = !reason || request.acceptPartial === true
    const title = usable && stdout ? sanitizeTitle(stdout) : null
    if (title) {
      if (request.memory)
        rememberTitleFailures(
          request.memory,
          request.plan.slice(0, failures.length),
          attempt,
          request.defaultProvider,
        )
      return { title: dedupeTitle(title, request.existingNames), failures, used: attempt }
    }
    failures.push({ reason: reason ?? 'empty', error: error ?? 'empty reply' })
    if (reason === 'timeout' || reason === 'aborted') break
  }
  return { title: null, failures }
}
