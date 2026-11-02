/**
 * The release manager's wire payload on `phosphor-release`. Import-free: the
 * Host, the desktop renderer and the web client parse it with this module.
 */
export const RELEASE_COMMAND = 'phosphor-release'
export const RELEASE_STATUS_KEY = 'phosphor-release'

/** Off; holding the repository's lease; waiting while another lane holds it. */
export type ReleaseRole = 'off' | 'active' | 'standby'

export interface ReleaseStatus {
  version: 1
  /** The repository has a release policy, so this lane may switch release mode on. */
  available: boolean
  /** Release mode is on in this lane. */
  enabled: boolean
  role: ReleaseRole
  /** The host holding the lease when it is not this lane. */
  holder?: string
  /** Bumped by every change of holder. */
  epoch?: number
  /**
   * The latest run is a release pass nobody needs to hear about. The Host
   * withholds its finished alert and This Mac its notice for such runs.
   */
  quiet: boolean
  /** The latest failure to reach GitHub or the lease, in plain words. */
  problem?: string
}

export function parseReleaseStatus(text: string | undefined): ReleaseStatus | null {
  try {
    const value = JSON.parse(text ?? '') as Partial<ReleaseStatus> | null
    if (
      value?.version !== 1 ||
      typeof value.available !== 'boolean' ||
      typeof value.enabled !== 'boolean' ||
      typeof value.quiet !== 'boolean' ||
      (value.role !== 'off' && value.role !== 'active' && value.role !== 'standby')
    )
      return null
    return {
      version: 1,
      available: value.available,
      enabled: value.enabled,
      role: value.role,
      quiet: value.quiet,
      ...(typeof value.holder === 'string' ? { holder: value.holder.slice(0, 80) } : {}),
      ...(Number.isSafeInteger(value.epoch) ? { epoch: value.epoch } : {}),
      ...(typeof value.problem === 'string' ? { problem: value.problem.slice(0, 300) } : {}),
    }
  } catch {
    return null
  }
}

/** A finished run this status covers needs no alert: a routine release pass. */
export function quietReleaseRun(text: string | undefined): boolean {
  const status = parseReleaseStatus(text)
  return !!status?.enabled && status.quiet
}
