import { isUuid } from '@shared/control-api'

/** Per account id, the Hosts this computer requests configure grants for. */
export type ConfigureHosts = Record<string, string[]>
const MAX_USERS = 8
const MAX_HOSTS = 64

export function cleanConfigureHosts(raw: unknown): ConfigureHosts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const clean: ConfigureHosts = {}
  for (const [user, hosts] of Object.entries(raw as Record<string, unknown>)) {
    if (!isUuid(user) || !Array.isArray(hosts)) continue
    const ids = [...new Set(hosts.filter((h): h is string => isUuid(h)))].slice(-MAX_HOSTS)
    if (ids.length) clean[user] = ids
  }
  const users = Object.keys(clean)
  for (const user of users.slice(0, Math.max(0, users.length - MAX_USERS))) delete clean[user]
  return clean
}

/**
 * The settings-access opt-in, remembered per signed-in account so it survives
 * restarts. Another account never sees it; explicit sign-out forgets it all.
 */
export function createConfigureHosts(ports: {
  user: () => string | null
  read: () => ConfigureHosts
  write: (value: ConfigureHosts) => void
}) {
  return {
    has(hostId: string): boolean {
      const user = ports.user()
      return !!user && (ports.read()[user]?.includes(hostId) ?? false)
    },
    set(hostId: string, enabled: boolean): void {
      const user = ports.user()
      // Disabling never fails: a rollback after sign-out has nothing left to forget.
      if (!user) {
        if (enabled) throw new Error('signed-out')
        return
      }
      // Re-inserting the user moves it last, so the eviction cap drops the stalest account.
      const { [user]: current = [], ...others } = ports.read()
      const rest = current.filter((id) => id !== hostId)
      ports.write(cleanConfigureHosts({ ...others, [user]: enabled ? [...rest, hostId] : rest }))
    },
  }
}
