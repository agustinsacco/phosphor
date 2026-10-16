import {
  CONTROL_LIMITS,
  machineStatus,
  normalizeUserCode,
  type MachineView,
  type Readiness,
} from '@shared/control-api'

export const LOCAL_MACHINE = 'this-computer'
export const HOST_GUIDE = 'https://github.com/agustinsacco/Phosphor/blob/main/docs/host.md'
export const HOST_INSTALL =
  'curl -fsSL https://github.com/agustinsacco/Phosphor/releases/download/host-latest/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && phosphor setup'
export const HOST_RUN = 'phosphor run'
export const HOST_SERVICE_INSTALL = 'phosphor service install'
export const HOST_SERVICE_STATUS = 'phosphor service status'
export const PI_INSTALL = 'npm install -g @earendil-works/pi-coding-agent'
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
export function statusText(machine: MachineView, now: number, offset = 0): string {
  if (!machine.lastSeenAt) return 'Waiting for first connection'
  // A stopping beat is a Host's last word: once it is old, the Host is offline.
  if (
    machine.state === 'stopping' &&
    now + offset - Date.parse(machine.lastSeenAt) <= CONTROL_LIMITS.downAfterSec * 1000
  )
    return 'Stopping'
  return machineStatus(machine, now, offset) === 'up'
    ? 'Online'
    : `Offline · last seen ${relativeTime(machine.lastSeenAt, now + offset)}`
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
}

/** Who the local row is: the machine's own word, never a repeated badge. */
export function localMachineLabel(platform: string): string {
  return platform === 'darwin' ? 'This Mac' : platform === 'win32' ? 'This PC' : 'This computer'
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

export function machineSubtitle(machine: MachineView, now: number, offset = 0): string {
  return [
    machine.hostname,
    `${platformName(machine.platform)} ${machine.arch}`,
    statusText(machine, now, offset),
  ].join(' · ')
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
              ? 'Install Claude Code on this machine.'
              : 'Not reported yet. Check the Host on this machine.',
      command:
        claude === 'signed-out'
          ? 'phosphor providers login claude'
          : claude === 'missing'
            ? 'npm install -g @anthropic-ai/claude-code'
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
export function formatCode(input: string): string {
  const canonical = normalizeUserCode(input)
  if (canonical) return `${canonical.slice(0, 4)}-${canonical.slice(4)}`
  const letters = input.toUpperCase().replace(/[\s-]/g, '')
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}
