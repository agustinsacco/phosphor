import { stat } from 'node:fs/promises'
import { contextBudgetTokens } from '@phosphor/shared/context-budget'
import { errorText } from '@phosphor/shared/errors'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { info, pass, warn, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { checkClaudeLane, type ClaudeLane } from '../machine/claude'
import type { PiEnvironment } from '../machine/environment'
import { checkGit, resolvePi } from '../machine/executables'
import { checkProviders, type ProviderState } from '../machine/providers'
import { checkRepositories } from '../machine/repositories'
import { checkExtensions } from '../machine/resources'
import { inspectTailscale, tailscaleChecks } from '../machine/tailscale'
import type { DoctorContext, Lane } from './doctor'
import { providersCheck, unavailable } from './doctor-report'

/** Probe sequentially: later checks consume earlier results, even after a failure. */
export async function inspectProbes(
  context: DoctorContext,
  config: HostConfigV1,
  environment: PiEnvironment,
  checks: Check[],
) {
  const timeoutMs = context.probeTimeoutMs
  const pi = await resolvePi(config.pi, environment, { timeoutMs })
  checks.push(...pi.checks)
  const git = await checkGit(environment)
  checks.push(git.check)
  checks.push(await checkExtensions(config.resourceRoot ?? context.defaultResourceRoot))
  const repositories = await checkRepositories(config.repositories, {
    home: context.home,
    git: git.git,
    environment,
  })
  checks.push(...repositories.checks)
  checks.push(await checkAgentDir())
  let providers: ProviderState[] | undefined
  let piDefault: string | undefined
  if (pi.launch) {
    const { defaultProvider } = await readAgentSettings()
    piDefault = typeof defaultProvider === 'string' ? defaultProvider : undefined
    providers = await checkProviders(pi.launch, environment, {
      defaultProvider: piDefault,
      timeoutMs,
    })
    checks.push(providersCheck(providers))
  }
  checks.push(budgetCheck(config.contextBudget ?? ''))
  checks.push(info('accounts', 'unavailable on a Host: pi uses the logins of the user running it'))
  checks.push(info('compression', 'unavailable on a Host: there is no Headroom proxy'))
  const tailscale = await inspectTailscale(config, context.env, context.platform, context.tailscale)
  checks.push(...tailscaleChecks(tailscale))

  return { pi, repositories, providers, piDefault, tailscale }
}

export type DoctorProbes = Awaited<ReturnType<typeof inspectProbes>>

/** Claude is optional and must not be probed until the native lane passes. */
export async function inspectClaude(
  context: DoctorContext,
  environment: PiEnvironment,
  native: Lane,
) {
  let claude = unavailable('needs the native lane')
  let claudeLane: ClaudeLane | null = null
  if (native.available) {
    try {
      const lane = await checkClaudeLane(await listPackages(), environment, {
        timeoutMs: context.probeTimeoutMs,
      })
      claudeLane = lane
      claude = lane.available
        ? { available: true, detail: `${lane.claude} ${lane.version}, logged in` }
        : unavailable(lane.reason)
    } catch (error) {
      claude = unavailable(`pi's packages could not be read: ${errorText(error)}`)
    }
  }

  return { claude, claudeLane }
}

async function checkAgentDir(): Promise<Check> {
  const dir = piAgentDir()
  const exists = await stat(dir).then(
    (stats) => stats.isDirectory(),
    () => false,
  )
  return exists
    ? pass('agent-dir', dir)
    : warn('agent-dir', `${dir} does not exist yet: run pi once as this user and log in`)
}

function budgetCheck(raw: string): Check {
  const tokens = contextBudgetTokens(raw)
  if (tokens === null) {
    return info('context-budget', `${raw.trim()}: sessions keep pi's own compaction threshold`)
  }
  const label = raw.trim() === '' ? ' (the default)' : ''
  return info('context-budget', `${Math.round(tokens / 1000)}k tokens${label}`)
}
