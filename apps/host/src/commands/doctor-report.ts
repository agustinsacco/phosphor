import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HOST_PROTOCOL_VERSION,
  validateHostHello,
  type HostCapability,
  type HostHello,
} from '@phosphor/shared/remote-host'
import { identityDirectory, readIdentityFile } from '../control/identity'
import { EXIT, exitCodeFor, fail, info, pass, warn, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { redact, type PiEnvironment } from '../machine/environment'
import { CLAUDE_CLI_PROVIDER, describeProvider, type ProviderState } from '../machine/providers'
import { tailscaleMessage, routeMessage } from '../machine/tailscale'
import { HOST_VERSION } from '../version'
import type { DoctorContext, DoctorReport, HostInspection, Lane } from './doctor'
import type { DoctorProbes } from './doctor-probes'

/** What a Host will offer once it can be reached (component 21). */
const CAPABILITIES: HostCapability[] = ['sessions.read', 'sessions.control']
export const unavailable = (reason: string): Lane => ({ available: false, reason })

export function nativeLane(checks: readonly Check[]) {
  const failed = [
    ...new Set(checks.filter((check) => check.status === 'fail').map((check) => check.id)),
  ]
  const native: Lane =
    failed.length === 0 ? { available: true } : unavailable(`failed: ${failed.join(', ')}`)
  return { failed, native }
}

/** Lane admission precedes the informational provider-warning substitution. */
export function reportPolicy(checks: Check[], probes: DoctorProbes, claude: Lane) {
  const { providers, piDefault, tailscale } = probes
  const { failed, native } = nativeLane(checks)
  // A ready claude lane is a usable model, so no signed-in pi provider is not a problem.
  const unsigned = checks.findIndex((c) => c.id === 'providers' && c.summary === NO_PROVIDER)
  if (claude.available && unsigned >= 0)
    checks[unsigned] = info('providers', 'no pi provider is signed in; the claude lane is ready')
  const exitCode = exitCodeFor(checks)
  const providerLogin =
    providers &&
    (providers.some((p) => p.default && p.status !== 'ready') ||
      (!providers.some((p) => p.status === 'ready') && !claude.available))
  const next =
    exitCode === EXIT.ok
      ? providerLogin
        ? 'sign in to a provider: phosphor providers login PROVIDER'
        : tailscale.readiness !== 'ok'
          ? tailscaleMessage(tailscale.readiness)
          : tailscale.state === 'absent'
            ? 'phosphor setup'
            : nextStep(providers ?? [], claude, piDefault)
      : failed.every((id) => id === 'Tailscale serve')
        ? routeMessage(tailscale.state, tailscale.port)
        : undefined
  return { native, claude, exitCode, next }
}

/** Public enrollment metadata is optional; a prompt never needs the signing key. */
export async function buildMachine(
  context: DoctorContext,
  config: HostConfigV1,
  environment: PiEnvironment,
  { pi, repositories }: DoctorProbes,
  native: Lane,
): Promise<HostInspection['machine']> {
  // Read public enrollment metadata only. Never load the signing key for a prompt.
  let machineLabel = context.hostname
  try {
    const metadata: unknown = JSON.parse(
      await readIdentityFile(identityDirectory(context.configPath), context.uid, 'host.json'),
    )
    if (
      metadata &&
      typeof metadata === 'object' &&
      'label' in metadata &&
      typeof metadata.label === 'string' &&
      metadata.label.trim()
    )
      machineLabel = metadata.label
  } catch {
    // Enrollment is optional and must not affect doctor or lane admission.
  }
  return native.available && pi.launch
    ? {
        pi: { binaryPath: pi.launch.binaryPath, prefixArgs: pi.launch.prefixArgs },
        env: environment.env,
        roots: repositories.roots,
        resourceRoot: config.resourceRoot ?? context.defaultResourceRoot,
        contextBudget: config.contextBudget ?? '',
        machineContext: {
          kind: 'host' as const,
          label: machineLabel,
          os:
            context.platform === 'darwin'
              ? 'macOS'
              : context.platform === 'win32'
                ? 'Windows'
                : context.platform === 'linux'
                  ? 'Linux'
                  : context.platform,
          repositories: config.repositories.map((repository) => basename(repository)),
        },
      }
    : null
}

/** The hello this Host would present, checked with validateHostHello. */
export function buildHello(hostId: string): HostHello {
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
export function helloExposure(hello: HostHello, environment: PiEnvironment): Check | null {
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

const NO_PROVIDER = 'none is signed in: phosphor providers'

/** Signed in to something pi runs on, with its default first: a session naming no model uses it. */
export function providersCheck(providers: readonly ProviderState[]): Check {
  const fallback = providers.find((provider) => provider.default)
  if (fallback && fallback.status !== 'ready') {
    const state = describeProvider(fallback)
    return warn('providers', `pi's default, ${fallback.name}, is ${state}: phosphor providers`)
  }
  const ready = providers.filter((provider) => provider.status === 'ready')
  if (ready.length === 0) return warn('providers', NO_PROVIDER)
  return pass('providers', `signed in: ${ready.map((provider) => provider.name).join(', ')}`)
}

const ACCEPT = 'phosphor accept --repository DIR'

/**
 * Setup is doctor, then a provider, then real sessions: what is left of it.
 * The accept named must pass as written. A lane runs on pi's default unless
 * told otherwise, and pi ignores a provider named without a model, so the
 * command names the lane, and the provider and model when the lane cannot
 * run on pi's default. `ID` is the one blank, with where to find one.
 */
export function nextStep(
  providers: readonly ProviderState[],
  claude: Lane,
  piDefault: string | undefined,
): string {
  if (piDefault === CLAUDE_CLI_PROVIDER && claude.available) {
    return `run real sessions on pi's default, the claude lane: ${ACCEPT} --lane claude`
  }
  const fallback = providers.find((provider) => provider.default)
  if (fallback?.status === 'ready') {
    return `run real sessions on pi's default, ${fallback.name}: ${ACCEPT} --lane native`
  }
  const ready = providers.find((provider) => provider.status === 'ready')
  if (ready) {
    return (
      `run real sessions on ${ready.name}: ${ACCEPT} --lane native --provider ${ready.id} ` +
      `--model ID (pi --list-models ${ready.id} lists them)`
    )
  }
  if (claude.available) {
    return (
      `run real sessions on the claude lane: ${ACCEPT} --lane claude --claude-model ID ` +
      `(pi --list-models ${CLAUDE_CLI_PROVIDER} lists them)`
    )
  }
  return 'sign in to a provider: phosphor providers'
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
    if (
      name === 'claude' &&
      !lane.available &&
      lane.reason === 'Claude Code is not installed: run phosphor setup'
    )
      lines.push("          pi's PATH is configured in /environment/path")
  }
  if (report.environment) {
    lines.push(`pi environment, names only`, `  ${report.environment.names.join(' ')}`)
  }
  lines.push(report.ok ? 'ready' : `not ready (exit ${report.exitCode})`)
  if (report.next) lines.push(`next: ${report.next}`)
  return `${lines.join('\n')}\n`
}
