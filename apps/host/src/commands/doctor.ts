import { lstat } from 'node:fs/promises'
import type { HostHello } from '@phosphor/shared/remote-host'
import { EXIT, fail, pass, warn, type Check } from '../checks'
import { loadHostConfig } from '../config/load'
import { resolveHostId, type ConfigError } from '../config/schema'
import { errnoIs } from '../fs-safety'
import type { ClaudeLane } from '../machine/claude'
import { buildPiEnvironment, type PiEnvironment } from '../machine/environment'
import { checkHostNode, type PiLaunch } from '../machine/executables'
import type { ProviderState } from '../machine/providers'
import type { tailscalePorts } from '../machine/tailscale'
import type { HostMachine } from '../session/runtime'
import { HOST_VERSION } from '../version'
import { inspectProbes, inspectClaude } from './doctor-probes'
import {
  buildHello,
  helloExposure,
  nativeLane,
  reportPolicy,
  buildMachine,
  redactStrings,
  unavailable,
} from './doctor-report'

export { nextStep, redactStrings, renderDoctor } from './doctor-report'

export interface DoctorContext {
  configPath: string
  /**
   * The Host's own environment, which pi's is built from. pi's directory
   * layout (`PI_CODING_AGENT_DIR`) is read from the process itself, as the
   * session runtime reads it.
   */
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  uid: number | undefined
  home: string
  hostname: string
  /** The node running the Host. */
  nodeVersion: string
  /** Holds `pi-ext/` when the config sets no resourceRoot: the bundle's own folder. */
  defaultResourceRoot: string
  /** Bound for each probe. Tests shorten it. */
  probeTimeoutMs?: number
  tailscale?: typeof tailscalePorts
}

export interface Lane {
  available: boolean
  /** Why it is unavailable. */
  reason?: string
  /** What it runs on, when available. */
  detail?: string
}

export interface DoctorReport {
  ok: boolean
  exitCode: number
  host: { version: string; node: string; platform: string }
  config: { path: string; hostId?: string; errors?: ConfigError[] }
  checks: Check[]
  lanes: { native: Lane; claude: Lane }
  /** Names only. PATH is shown as folders: the Host builds it from the config. */
  environment?: { names: string[]; path: string[] }
  /** The hello this Host would present once component 21 can serve it. */
  hello?: HostHello
  /** What pi can sign into, and its default provider, once pi itself is usable. */
  providers?: ProviderState[]
  /** The next setup step, when ready or when the config is missing. */
  next?: string
}

/** What doctor found, for a command that goes on to run sessions. */
export interface HostInspection {
  report: DoctorReport
  /** What the session runtime needs, unredacted, when the native lane is available. */
  machine: Omit<HostMachine, 'log'> | null
  /** The values to hide in anything that leaves the Host. */
  secrets: readonly string[]
  /** pi's version, once resolved. */
  piVersion: string | null
  /** The Claude lane as checked, with its claude and version. */
  claude: ClaudeLane | null
  /** pi and its environment whenever pi itself passed, even when another check failed. */
  pi: { launch: PiLaunch; environment: PiEnvironment } | null
}

/**
 * Check that this machine can run a Host. Starts no session and calls no
 * provider: every program it runs is asked for a version or a status.
 * Every string in the report has the secret values of pi's environment
 * replaced, so it is safe to paste.
 */
export async function runDoctor(context: DoctorContext): Promise<DoctorReport> {
  return (await inspectHost(context)).report
}

/** doctor's checks, with what a session needs when the machine passes them. */
export async function inspectHost(context: DoctorContext): Promise<HostInspection> {
  const host = { version: HOST_VERSION, node: context.nodeVersion, platform: context.platform }
  const checks: Check[] = [checkHostNode(context.nodeVersion)]
  const loaded = await loadHostConfig(context.configPath, context.uid)
  if (!loaded.ok) return configFailure(host, checks, loaded)
  const { config } = loaded
  checks.push(pass('config', loaded.path))

  const environment = buildPiEnvironment({
    hostEnv: context.env,
    pass: config.environment?.pass,
    path: config.environment?.path,
    nodePath: config.pi.node,
    platform: context.platform,
  })
  if (environment.ambient.length > 0) {
    const names = environment.ambient.join(', ')
    checks.push(warn('environment', `pi receives ${names}, which act on other systems for you`))
  }
  if (environment.unset.length > 0) {
    const names = environment.unset.join(', ')
    checks.push(warn('environment', `the config passes ${names}, which this Host does not have`))
  }

  const hostId = resolveHostId(config, context.hostname)
  const hello = buildHello(hostId)
  const exposed = helloExposure(hello, environment)
  if (exposed) checks.push(exposed)

  const probes = await inspectProbes(context, config, environment, checks)
  const { claude, claudeLane } = await inspectClaude(
    context,
    environment,
    nativeLane(checks).native,
  )
  const { native, exitCode, next } = reportPolicy(checks, probes, claude)
  const { pi, providers } = probes
  const report = redactStrings(
    {
      ok: exitCode === EXIT.ok,
      exitCode,
      host,
      config: { path: loaded.path, hostId },
      checks,
      lanes: { native, claude },
      environment: { names: environment.names, path: environment.env.PATH!.split(':') },
      ...(exposed ? {} : { hello }),
      ...(providers ? { providers } : {}),
      ...(next ? { next } : {}),
    },
    environment.secrets,
  )
  const machine = await buildMachine(context, config, environment, probes, native)
  return {
    report,
    machine,
    secrets: environment.secrets,
    piVersion: pi.launch?.version ?? null,
    claude: claudeLane,
    pi: pi.launch ? { launch: pi.launch, environment } : null,
  }
}

async function configFailure(
  host: DoctorReport['host'],
  checks: Check[],
  loaded: Extract<Awaited<ReturnType<typeof loadHostConfig>>, { ok: false }>,
): Promise<HostInspection> {
  checks.push(fail('config', `${loaded.path} is not usable`, EXIT.config))
  const report: DoctorReport = {
    ok: false,
    exitCode: EXIT.config,
    host,
    config: { path: loaded.path, errors: loaded.errors },
    checks,
    lanes: { native: unavailable('no usable config'), claude: unavailable('no usable config') },
  }
  const missing = await lstat(loaded.path).then(
    () => false,
    (error: unknown) => error instanceof Error && errnoIs(error, 'ENOENT'),
  )
  if (missing) report.next = 'run phosphor setup'
  return { report, machine: null, secrets: [], piVersion: null, claude: null, pi: null }
}
