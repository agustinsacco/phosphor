import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { contextBudgetTokens } from '@phosphor/shared/context-budget'
import { errorText } from '@phosphor/shared/errors'
import {
  HOST_PROTOCOL_VERSION,
  validateHostHello,
  type HostCapability,
  type HostHello,
} from '@phosphor/shared/remote-host'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { EXIT, exitCodeFor, fail, info, pass, warn, type Check } from '../checks'
import { loadHostConfig } from '../config/load'
import { resolveHostId, type ConfigError } from '../config/schema'
import { checkClaudeLane, type ClaudeLane } from '../machine/claude'
import { buildPiEnvironment, redact, type PiEnvironment } from '../machine/environment'
import { checkGit, checkHostNode, resolvePi } from '../machine/executables'
import { checkRepositories } from '../machine/repositories'
import { checkExtensions } from '../machine/resources'
import type { HostMachine } from '../session/runtime'
import { HOST_VERSION } from '../version'

/** What a Host will offer once it can be reached (component 21). */
const CAPABILITIES: HostCapability[] = ['sessions.read', 'sessions.control']

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
}

const unavailable = (reason: string): Lane => ({ available: false, reason })

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
  if (!loaded.ok) {
    checks.push(fail('config', `${loaded.path} is not usable`, EXIT.config))
    const report: DoctorReport = {
      ok: false,
      exitCode: EXIT.config,
      host,
      config: { path: loaded.path, errors: loaded.errors },
      checks,
      lanes: { native: unavailable('no usable config'), claude: unavailable('no usable config') },
    }
    return { report, machine: null, secrets: [], piVersion: null, claude: null }
  }
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
  checks.push(budgetCheck(config.contextBudget ?? ''))
  checks.push(info('accounts', 'unavailable on a Host: pi uses the logins of the user running it'))
  checks.push(info('compression', 'unavailable on a Host: there is no Headroom proxy'))

  const failed = [...new Set(checks.filter((c) => c.status === 'fail').map((c) => c.id))]
  const native: Lane =
    failed.length === 0 ? { available: true } : unavailable(`failed: ${failed.join(', ')}`)
  let claude = unavailable('needs the native lane')
  let claudeLane: ClaudeLane | null = null
  if (native.available) {
    try {
      const lane = await checkClaudeLane(await listPackages(), environment, { timeoutMs })
      claudeLane = lane
      claude = lane.available
        ? { available: true, detail: `${lane.claude} ${lane.version}, logged in` }
        : unavailable(lane.reason)
    } catch (error) {
      claude = unavailable(`pi's packages could not be read: ${errorText(error)}`)
    }
  }

  const exitCode = exitCodeFor(checks)
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
    },
    environment.secrets,
  )
  const machine =
    native.available && pi.launch
      ? {
          pi: { binaryPath: pi.launch.binaryPath, prefixArgs: pi.launch.prefixArgs },
          env: environment.env,
          roots: repositories.roots,
          resourceRoot: config.resourceRoot ?? context.defaultResourceRoot,
          contextBudget: config.contextBudget ?? '',
        }
      : null
  return {
    report,
    machine,
    secrets: environment.secrets,
    piVersion: pi.launch?.version ?? null,
    claude: claudeLane,
  }
}

/** The hello this Host would present, checked with validateHostHello. */
function buildHello(hostId: string): HostHello {
  const hello: HostHello = {
    hostId,
    hostVersion: HOST_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runtimeEpoch: randomUUID(),
    capabilities: CAPABILITIES,
  }
  const presented = validateHostHello(hello, hostId)
  if (!presented.ok) throw new Error(`this Host's hello is invalid: ${presented.reason}`)
  return presented.hello
}

/**
 * A failure when the hello holds a secret value of pi's environment: the
 * report would show it redacted, and a client would receive the value
 * itself. It names the field and the variable, never the value, and says
 * how to fix it: the host id is the one field the config sets.
 */
function helloExposure(hello: HostHello, environment: PiEnvironment): Check | null {
  const holds = (field: keyof HostHello, secrets: readonly string[]) =>
    JSON.stringify(redactStrings(hello[field], secrets)) !== JSON.stringify(hello[field])
  const fields = (Object.keys(hello) as (keyof HostHello)[]).filter((field) =>
    holds(field, environment.secrets),
  )
  if (fields.length === 0) return null
  const inHostId = fields.includes('hostId')
  const reported: (keyof HostHello)[] = inHostId ? ['hostId'] : fields
  const holders = environment.names
    .filter((name) => {
      const value = environment.env[name]!
      return environment.secrets.includes(value) && reported.some((field) => holds(field, [value]))
    })
    .join(', ')
  const where =
    reported.length === 1
      ? `the hello field ${reported[0]} holds`
      : `the hello fields ${reported.join(', ')} hold`
  const summary = inHostId
    ? `the host id holds the value of ${holders}, which pi receives: set /hostId to another name`
    : `${where} the value of ${holders}, which pi receives: ` +
      "change that value, or keep it out of pi's environment"
  return fail('hello', summary, EXIT.config)
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

/** Every string in a JSON-shaped value, with each secret value replaced. */
export function redactStrings<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === 'string' ? redact(item, secrets) : item,
  ) as T
}

const MARK = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' } as const

export function renderDoctor(report: DoctorReport): string {
  const { host } = report
  const lines = [`phosphor ${host.version} · node ${host.node} · ${host.platform}`]
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]}  ${check.id.padEnd(15)} ${check.summary}`)
  }
  for (const error of report.config.errors ?? []) {
    lines.push(`        ${error.pointer || '(file)'}: ${error.message}`)
  }
  lines.push('lanes')
  for (const [name, lane] of Object.entries(report.lanes)) {
    const state = lane.available
      ? `available${lane.detail ? `: ${lane.detail}` : ''}`
      : `unavailable: ${lane.reason}`
    lines.push(`  ${name.padEnd(7)} ${state}`)
  }
  if (report.environment) {
    lines.push(`pi environment, names only`, `  ${report.environment.names.join(' ')}`)
  }
  lines.push(report.ok ? 'ready' : `not ready (exit ${report.exitCode})`)
  return `${lines.join('\n')}\n`
}
