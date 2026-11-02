import {
  machineStatus,
  normalizeUserCode,
  type MachineView,
  type Readiness,
} from '@shared/control-api'
import type { IpcInvokeMap } from '@shared/ipc'
import type { ClaudeStatus, PiHealth } from '@shared/models'

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
export const CLAUDE_SETUP = 'Set it up in Settings → Extensions → Claude Code.'
export function platformName(platform: string): string {
  return { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[platform] ?? platform
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

export function readinessChecks(
  readiness: Readiness | null,
  endpoint?: string | null,
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
            ? 'Sign in to Claude Code on this machine.'
            : claude === 'missing'
              ? `Claude Code is missing. ${CLAUDE_SETUP}`
              : 'Not reported yet. Check the Host on this machine.',
      command:
        claude === 'signed-out'
          ? 'phosphor providers login claude'
          : claude === 'unknown'
            ? 'phosphor doctor'
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
          ? 'Connected with HTTPS available'
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
/** A Host's live Claude Code detail, which names the missing part. */
export function claudeReadiness(
  detail: NonNullable<IpcInvokeMap['hosts:claude']['result']>,
): ReadinessCheck {
  const name = 'Claude Code'
  if (detail.provider !== 'ok')
    return {
      name,
      ok: false,
      short: `Claude Code provider ${detail.provider}`,
      detail: `Claude Code provider ${detail.provider}. ${CLAUDE_SETUP}`,
    }
  if (detail.cli !== 'ok')
    return {
      name,
      ok: false,
      short: 'Claude Code missing',
      detail: `Claude Code is missing. ${CLAUDE_SETUP}`,
    }
  return {
    name,
    ok: detail.auth === 'ok',
    short: `Claude Code ${detail.auth}`,
    detail:
      detail.auth === 'ok'
        ? 'Signed in and ready'
        : detail.auth === 'signed-out'
          ? 'Sign in to Claude Code on this machine.'
          : 'Claude Code sign-in status is unknown. Run phosphor setup on this machine.',
    command:
      detail.auth === 'ok'
        ? undefined
        : detail.auth === 'signed-out'
          ? 'phosphor providers login claude'
          : 'phosphor setup',
  }
}

/** This computer's pi and Claude Code. Each read is `undefined` until it settles. */
export function localChecks(
  health: PiHealth | null | undefined,
  claude: ClaudeStatus | null | undefined,
  failed: boolean,
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
          : (health.reason ?? 'Install pi to run lanes.')
        : 'Could not check pi.',
      command: health && !health.ok ? PI_INSTALL : undefined,
    },
    {
      name: 'Claude Code',
      ok: claude?.binary.found === true && claude.auth.loggedIn === true,
      loading: claude === undefined && !failed,
      short: !claude
        ? 'Not checked'
        : !claude.binary.found
          ? 'Claude Code missing'
          : claude.auth.loggedIn
            ? 'Signed in'
            : 'Claude Code signed out',
      detail: !claude
        ? 'Could not check Claude Code.'
        : !claude.binary.found
          ? `Claude Code is missing. ${CLAUDE_SETUP}`
          : claude.auth.loggedIn
            ? 'Signed in and ready'
            : 'Sign in under Settings → Extensions → Claude Code.',
    },
  ]
}

export function formatCode(input: string): string {
  const canonical = normalizeUserCode(input)
  if (canonical) return `${canonical.slice(0, 4)}-${canonical.slice(4)}`
  const letters = input.toUpperCase().replace(/[\s-]/g, '')
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}
