import {
  machineStatus,
  normalizeUserCode,
  type MachineView,
  type Readiness,
} from '@shared/control-api'
import type { MachineClaude } from '@shared/host-protocol-machine'
import type { PhosphorApi } from '@shared/ipc'
import { claudeProviderState, type PiHealth } from '@shared/models'
import type { TailscaleCode, TailscaleStatus } from '@shared/tailscale-status'

export const HOST_GUIDE = 'https://github.com/agustinsacco/Phosphor/blob/main/docs/host.md'
export const HOST_INSTALL =
  'curl -fsSL https://github.com/agustinsacco/Phosphor/releases/download/host-latest/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && phosphor setup'
export const HOST_RUN = 'phosphor run'
export const HOST_SERVICE_INSTALL = 'phosphor service install'
export const HOST_SERVICE_STATUS = 'phosphor service status'
export const PI_INSTALL = 'npm install -g @earendil-works/pi-coding-agent'
/**
 * The one fix for a missing or outdated Claude Code on any machine: its
 * Settings page installs the provider and the CLI, or says how.
 */
const CLAUDE_SETUP = 'Set it up in Settings → Extensions → Claude Code.'
/** A Host that cannot open its Settings installs Claude Code with its own setup. */
const HOST_CLAUDE_SETUP = 'Run phosphor setup on this machine.'
function claudeSetup(configurable: boolean): { text: string; command?: string } {
  return configurable
    ? { text: CLAUDE_SETUP }
    : { text: HOST_CLAUDE_SETUP, command: 'phosphor setup' }
}
/** Signing in to Claude Code: in Settings where it opens, otherwise the Host's own command. */
function claudeSignIn(configurable: boolean): { text: string; command?: string } {
  return configurable
    ? { text: 'Sign in under Settings → Extensions → Claude Code.' }
    : {
        text: 'Sign in to Claude Code on this machine.',
        command: 'phosphor providers login claude',
      }
}
/** A ready Tailscale, on This Mac or a Host. */
export const TAILSCALE_READY = 'Connected with HTTPS available'
/** This computer's Tailscale while the account reaches no Hosts: optional, never a problem. */
export const TAILSCALE_OPTIONAL = 'Needed only to reach your Hosts'
/** What this computer's Tailscale needs, by its read-only status. */
export const TAILSCALE_FIXES: Record<TailscaleCode, string> = {
  ready: 'Tailscale is running and logged in. MagicDNS and HTTPS certificates are available.',
  'not-installed': 'Install Tailscale on this computer, then sign in to your tailnet.',
  'not-running': 'Open Tailscale and connect to your tailnet, then check again.',
  'signed-out': 'Sign in to Tailscale and approve this computer in its admin console.',
  'magicdns-unavailable': 'Turn on MagicDNS in the Tailscale admin console DNS settings.',
  'https-unavailable': 'Turn on HTTPS certificates in the Tailscale admin console DNS settings.',
  'check-failed': 'Could not check Tailscale. Open Tailscale to check your connection manually.',
}
const TAILSCALE_SHORT: Record<TailscaleCode, string> = {
  ready: 'Tailscale ok',
  'not-installed': 'Tailscale missing',
  'not-running': 'Tailscale stopped',
  'signed-out': 'Tailscale signed out',
  'magicdns-unavailable': 'No MagicDNS',
  'https-unavailable': 'No Tailscale HTTPS',
  'check-failed': 'Tailscale not checked',
}
export function relativeTime(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86400)} d ago`
}
export function sortMachines(
  machines: readonly MachineView[],
  now: number,
  offset = 0,
): MachineView[] {
  return [...machines].sort(
    (a, b) =>
      Number(machineStatus(b, now, offset) === 'up') -
        Number(machineStatus(a, now, offset) === 'up') ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  )
}
export interface ReadinessCheck {
  name: string
  ok: boolean
  /** A few words for a list row, such as "Claude Code signed out". */
  short: string
  detail: string
  command?: string
  /** Still being read; shows a spinner instead of a verdict. */
  loading?: boolean
  /** What the row says while loading, when not "Checking…". */
  loadingText?: string
  /** Not applicable or not reported: neither passing nor failing. */
  muted?: boolean
}

/**
 * How far a machine's readiness can be trusted. A machine that never sent a
 * heartbeat has none; one that is offline has only what it last reported.
 */
export function readinessFreshness(
  machine: MachineView,
  now: number,
  offset = 0,
): 'none' | 'stale' | 'live' {
  if (!machine.lastSeenAt || !machine.readiness) return 'none'
  return machineStatus(machine, now, offset) === 'up' ? 'live' : 'stale'
}

/** `configurable`: the machine can open its Settings, where Claude Code is set up. */
export function readinessChecks(
  readiness: Readiness | null,
  endpoint?: string | null,
  configurable = true,
): ReadinessCheck[] {
  const pi = readiness?.pi ?? 'unknown'
  const claude = readiness?.claude ?? 'unknown'
  const tailscale = readiness?.tailscale ?? 'unknown'
  const unpublished = tailscale === 'ok' && endpoint === null
  return [
    {
      name: 'pi',
      ok: pi === 'ok',
      short: pi === 'unknown' ? 'pi not reported' : `pi ${pi}`,
      detail:
        pi === 'ok'
          ? 'Ready to run lanes'
          : pi === 'unknown'
            ? 'Not reported yet. Check the Host on this machine.'
            : pi === 'outdated'
              ? 'Update pi to the supported version.'
              : 'Install pi on this machine.',
      command: pi === 'unknown' ? 'phosphor doctor' : pi === 'ok' ? undefined : PI_INSTALL,
    },
    {
      name: 'Claude Code',
      ok: claude === 'ok',
      short:
        claude === 'signed-out'
          ? 'Claude Code signed out'
          : claude === 'unknown'
            ? 'Claude Code not reported'
            : `Claude Code ${claude}`,
      detail:
        claude === 'ok'
          ? 'Signed in and ready'
          : claude === 'signed-out'
            ? claudeSignIn(configurable).text
            : claude === 'missing'
              ? `Claude Code is missing. ${claudeSetup(configurable).text}`
              : 'Not reported yet. Check the Host on this machine.',
      command:
        claude === 'signed-out'
          ? claudeSignIn(configurable).command
          : claude === 'unknown'
            ? 'phosphor doctor'
            : claude === 'missing'
              ? claudeSetup(configurable).command
              : undefined,
    },
    {
      name: 'Tailscale',
      ok: tailscale === 'ok' && !unpublished,
      short: unpublished
        ? 'Address not published'
        : tailscale === 'no-https'
          ? 'No Tailscale HTTPS'
          : tailscale === 'unknown'
            ? 'Tailscale not reported'
            : `Tailscale ${tailscale}`,
      detail: unpublished
        ? 'Running, but its address is not published'
        : tailscale === 'ok'
          ? TAILSCALE_READY
          : tailscale === 'stopped'
            ? 'Start Tailscale on this machine.'
            : tailscale === 'no-https'
              ? 'Enable HTTPS certificates in your tailnet admin console.'
              : tailscale === 'missing'
                ? 'Install Tailscale on this machine: tailscale.com/download.'
                : 'Not reported yet. Check the Host on this machine.',
      command:
        tailscale === 'stopped'
          ? 'sudo tailscale up'
          : tailscale === 'unknown'
            ? 'phosphor doctor'
            : undefined,
    },
  ]
}
/**
 * This computer's Claude Code in a Host's terms (the counterpart of `hosts:claude`),
 * by the Host's provider rule.
 */
export async function readLocalClaude(invoke: PhosphorApi['invoke']): Promise<MachineClaude> {
  const [packages, status] = await Promise.all([
    invoke('packages:list'),
    invoke('packages:claudeStatus'),
  ])
  return {
    provider: claudeProviderState(packages),
    cli: status.binary.found ? 'ok' : 'missing',
    auth:
      status.auth.loggedIn === true
        ? 'ok'
        : status.auth.loggedIn === false
          ? 'signed-out'
          : 'unknown',
  }
}

/** A machine's Claude Code detail, which names the missing part. */
export function claudeReadiness(detail: MachineClaude, configurable = true): ReadinessCheck {
  const name = 'Claude Code'
  const setup = claudeSetup(configurable)
  if (detail.provider !== 'ok')
    return {
      name,
      ok: false,
      short: `Claude Code provider ${detail.provider}`,
      detail: `Claude Code provider ${detail.provider}. ${setup.text}`,
      command: setup.command,
    }
  if (detail.cli !== 'ok')
    return {
      name,
      ok: false,
      short: 'Claude Code missing',
      detail: `Claude Code is missing. ${setup.text}`,
      command: setup.command,
    }
  if (detail.auth === 'ok')
    return { name, ok: true, short: 'Claude Code ok', detail: 'Signed in and ready' }
  const signIn = claudeSignIn(configurable)
  return detail.auth === 'signed-out'
    ? {
        name,
        ok: false,
        short: 'Claude Code signed out',
        detail: signIn.text,
        command: signIn.command,
      }
    : {
        name,
        ok: false,
        short: 'Claude Code unknown',
        detail: `Claude Code sign-in status is unknown. ${configurable ? 'Check it under Settings → Extensions → Claude Code.' : setup.text}`,
        command: setup.command,
      }
}

/** This computer's reads; each is `undefined` until it settles. */
export interface LocalReadings {
  health?: PiHealth | null
  claude?: MachineClaude | null
  tailscale?: TailscaleStatus
  failed: boolean
}

/**
 * Why This Mac's pi cannot run lanes, without a command: the row offers
 * `PI_INSTALL`, and main's messages for these two reasons end with their own.
 * The health check's pi step says the same.
 */
export function piUnavailable(health: PiHealth): string {
  if (health.reason === 'too-old') return `pi ${health.version} is older than ${health.minVersion}.`
  if (health.reason === 'not-found') return 'pi was not found on your PATH.'
  return health.message ?? 'Install pi to run lanes.'
}

/**
 * This computer's pi, Claude Code and Tailscale. Tailscale only reaches Hosts:
 * without any (`reachesHosts` false) it is optional, muted rather than a problem.
 */
export function localChecks(
  { health, claude, tailscale, failed }: LocalReadings,
  reachesHosts: boolean,
): ReadinessCheck[] {
  return [
    {
      name: 'pi',
      ok: health?.ok === true,
      loading: health === undefined && !failed,
      short: health ? (health.ok ? `pi ${health.version}` : 'pi unavailable') : 'Not checked',
      detail: health
        ? health.ok
          ? `Ready · ${health.version}`
          : piUnavailable(health)
        : 'Could not check pi.',
      command: health && !health.ok ? PI_INSTALL : undefined,
    },
    claude
      ? claudeReadiness(claude)
      : {
          name: 'Claude Code',
          ok: false,
          loading: claude === undefined && !failed,
          short: 'Not checked',
          detail: 'Could not check Claude Code.',
        },
    {
      name: 'Tailscale',
      ok: tailscale?.code === 'ready',
      loading: tailscale === undefined,
      muted: !reachesHosts,
      short: TAILSCALE_SHORT[tailscale?.code ?? 'check-failed'],
      detail:
        tailscale?.code === 'ready'
          ? TAILSCALE_READY
          : `${reachesHosts ? '' : `${TAILSCALE_OPTIONAL}. `}${TAILSCALE_FIXES[tailscale?.code ?? 'check-failed']}`,
    },
  ]
}

export function formatCode(input: string): string {
  const canonical = normalizeUserCode(input)
  if (canonical) return `${canonical.slice(0, 4)}-${canonical.slice(4)}`
  const letters = input.toUpperCase().replace(/[\s-]/g, '')
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}
