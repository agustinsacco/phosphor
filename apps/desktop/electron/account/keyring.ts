import { spawnSync } from 'node:child_process'

export type PasswordStore = 'gnome-libsecret' | 'kwallet6' | 'kwallet5'
export interface BusNames {
  owned: readonly string[]
  activatable: readonly string[]
}
const RECOGNISED = new Set([
  'GNOME',
  'UNITY',
  'X-CINNAMON',
  'DEEPIN',
  'PANTHEON',
  'XFCE',
  'UKUI',
  'COSMIC',
  'KDE',
])

/** Chromium already chooses a keyring on these desktops. Respect an explicit switch. */
export function passwordStore(
  platform: NodeJS.Platform,
  explicit: boolean,
  env: NodeJS.ProcessEnv,
  probe: () => BusNames | null,
): PasswordStore | null {
  if (platform !== 'linux' || explicit || !env.DBUS_SESSION_BUS_ADDRESS) return null
  if (
    env.XDG_CURRENT_DESKTOP?.toUpperCase()
      .split(':')
      .some((d) => RECOGNISED.has(d))
  )
    return null
  let names: BusNames | null
  try {
    names = probe()
  } catch {
    return null
  }
  if (!names) return null
  if ([...names.owned, ...names.activatable].includes('org.freedesktop.secrets'))
    return 'gnome-libsecret'
  if (names.owned.includes('org.kde.kwalletd6')) return 'kwallet6'
  if (names.owned.includes('org.kde.kwalletd5')) return 'kwallet5'
  return null
}

/** Two bounded bus queries, sharing one deadline. stdin is closed and no shell runs. */
export function probeKeyring(run = spawnSync, now = Date.now): BusNames | null {
  const deadline = now() + 1_000
  function list(method: string): string[] | null {
    const timeout = deadline - now()
    if (timeout <= 0) return null
    const result = run(
      'dbus-send',
      [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        `org.freedesktop.DBus.${method}`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout,
        maxBuffer: 64 * 1024,
        shell: false,
      },
    )
    if (result.error || result.status !== 0) return null
    return Array.from(result.stdout.matchAll(/string "([A-Za-z0-9_.:-]+)"/g), (m) => m[1] ?? '')
  }
  const owned = list('ListNames')
  if (!owned) return null
  const activatable = list('ListActivatableNames')
  return activatable ? { owned, activatable } : null
}

export function configureLinuxKeyring(
  commandLine: {
    hasSwitch(name: string): boolean
    appendSwitch(name: string, value: string): void
  },
  log: (message: string) => void,
  platform = process.platform,
  env = process.env,
  probe = probeKeyring,
): void {
  const selected = passwordStore(platform, commandLine.hasSwitch('password-store'), env, probe)
  if (selected) {
    commandLine.appendSwitch('password-store', selected)
    log(`selected password store: ${selected}`)
  }
}
