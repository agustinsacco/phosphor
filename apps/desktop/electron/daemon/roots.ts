import { isAbsolute, join, normalize } from 'node:path'
import type { HostReleaseKey } from '@phosphor/shared/host-release'
import {
  HOST_AGENT,
  HOST_UNIT,
  hostConfigDirectory,
  hostStateDirectory,
} from '@phosphor/shared/host-local'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'

/**
 * Every location the service install reads or writes, derived from one HOME.
 * A packaged app uses the user's real HOME. An unpackaged build installs
 * nothing unless the dev hook names a scratch root, a `file:` release folder
 * and the throwaway key that signed it; it never touches the real ~/.local,
 * LaunchAgents, systemd units or pi's agent folder.
 */

export const DAEMON_ROOT_ENV = 'PHOSPHOR_DAEMON_ROOT'
export const DAEMON_RELEASE_KEY_ENV = 'PHOSPHOR_DAEMON_RELEASE_KEY'

export interface DaemonRoots {
  platform: 'darwin' | 'linux'
  /** The release target, `<platform>-<arch>`. */
  target: string
  home: string
  /** `<home>/.local/lib/phosphor-host`: versions, `current` and the install lock. */
  lib: string
  /** pi's agent folder, where the owner lock lives. */
  agentDir: string
  /** The LaunchAgent plist or systemd unit a Host service would have written. */
  serviceFile: string
  /** XDG folders the service child must see; empty when the user set none. */
  xdg: Record<string, string>
  /** The service's config folder (`local-identity.json`), as the Host resolves it from `xdg`. */
  configDir: string
  /** The service's state folder (`local.json`), as the Host resolves it from `xdg`. */
  stateDir: string
  /** Release lookup: `env` carries only the release URL override, `keys` only test keys. */
  release: { env: NodeJS.ProcessEnv; keys?: readonly HostReleaseKey[] }
}

export type DaemonRootsResult = { on: true; roots: DaemonRoots } | { on: false; reason: string }

export interface DaemonRootsInput {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  /** The real HOME (`os.homedir()`). */
  home: string
  platform: NodeJS.Platform
  arch: string
}

const off = (reason: string): DaemonRootsResult => ({ on: false, reason })
const absolute = (value: string | undefined): string | undefined =>
  value && isAbsolute(value) ? value : undefined
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)

function build(
  platform: 'darwin' | 'linux',
  arch: string,
  home: string,
  xdg: Record<string, string>,
  agentDir: string,
  release: DaemonRoots['release'],
): DaemonRoots {
  return {
    platform,
    target: `${platform}-${arch}`,
    home,
    lib: join(home, '.local/lib/phosphor-host'),
    agentDir,
    serviceFile:
      platform === 'darwin'
        ? join(home, 'Library/LaunchAgents', `${HOST_AGENT}.plist`)
        : join(xdg.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd/user', HOST_UNIT),
    xdg,
    configDir: hostConfigDirectory(xdg, home),
    stateDir: hostStateDirectory(xdg, home),
    release,
  }
}

/** The dev hook's scratch root, refused when it is or holds the real HOME or one of its service folders. */
function scratchRoot(env: NodeJS.ProcessEnv, home: string): string | null {
  const root = absolute(env[DAEMON_ROOT_ENV])
  if (!root || normalize(root) !== root || root === '/') return null
  const real = normalize(home)
  if (within(real, root)) return null
  for (const folder of ['.local', 'Library', '.config', '.pi', '.claude'])
    if (within(root, join(real, folder))) return null
  return root
}

function devRoots(input: DaemonRootsInput, platform: 'darwin' | 'linux'): DaemonRootsResult {
  if (input.env[DAEMON_ROOT_ENV] === undefined)
    return off('Development builds never install the Phosphor service.')
  const root = scratchRoot(input.env, input.home)
  const url = input.env.PHOSPHOR_HOST_RELEASE_URL
  const key = input.env[DAEMON_RELEASE_KEY_ENV]
  if (!root) return off(`${DAEMON_ROOT_ENV} must be a scratch folder outside your home folders.`)
  if (!url?.startsWith('file:') || !key?.startsWith('ssh-ed25519 '))
    return off(
      `${DAEMON_ROOT_ENV} needs a file: PHOSPHOR_HOST_RELEASE_URL and ${DAEMON_RELEASE_KEY_ENV}.`,
    )
  const home = join(root, 'home')
  const xdg = {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'),
  }
  return {
    on: true,
    roots: build(platform, input.arch, home, xdg, join(home, '.pi/agent'), {
      env: { PHOSPHOR_HOST_RELEASE_URL: url },
      keys: [{ id: 'dev', publicKey: key }],
    }),
  }
}

export function daemonRoots(input: DaemonRootsInput): DaemonRootsResult {
  const { platform } = input
  if (platform !== 'darwin' && platform !== 'linux')
    return off('This computer keeps the in-app runtime.')
  if (!input.isPackaged) return devRoots(input, platform)
  const xdg: Record<string, string> = {}
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const) {
    const value = absolute(input.env[name])
    if (value) xdg[name] = value
  }
  return {
    on: true,
    roots: build(platform, input.arch, input.home, xdg, piAgentDir(input.env, input.home), {
      env: {},
    }),
  }
}
