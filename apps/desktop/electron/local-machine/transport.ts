import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join, normalize } from 'node:path'
import {
  HOST_SIDECARS,
  LOCAL_LIMITS,
  parseLocalIdentityFile,
  parseLocalRunFile,
  type LocalIdentityFile,
} from '@phosphor/shared/host-local'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import type { DaemonRootsResult } from '../daemon/roots'

/**
 * How Desktop main reaches This Mac's own Phosphor service: where its socket
 * and identity are, the socket's hello, and a `ws+unix:` frame socket. Node
 * only, on purpose: `libs/host-client` stays browser-safe and sees only the
 * `FrameSocket` this returns.
 */

/** Unpackaged only: the socket of a daemon a test or dev session started. */
export const LOCAL_DAEMON_SOCKET_ENV = 'PHOSPHOR_LOCAL_DAEMON_SOCKET'
/** Unpackaged only: that daemon's config folder, which holds `local-identity.json`. */
export const LOCAL_DAEMON_CONFIG_ENV = 'PHOSPHOR_LOCAL_DAEMON_CONFIG'

const SIDECAR_MAX_BYTES = 64 * 1024

/**
 * `dev`: both gated variables name the daemon. `service`: the installed
 * service's folders, from M1's install roots; `local.json` names its socket.
 */
export type LocalDaemonLocation =
  | { kind: 'dev'; socket: string; configDir: string }
  | { kind: 'service'; configDir: string; stateDir: string }

export type LocalDaemonLocationResult =
  { on: true; location: LocalDaemonLocation } | { on: false; reason: string }

export interface LocalDaemonLocationInput {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  /** The real HOME (`os.homedir()`). */
  home: string
  /** M1's install roots; only a packaged app reads them. */
  roots: DaemonRootsResult
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)

/** An absolute, normalized path outside the real home's config, state and service folders. */
function scratchPath(value: string | undefined, home: string): string | null {
  if (!value?.startsWith('/') || normalize(value) !== value || value === '/') return null
  const real = normalize(home)
  if (within(real, value)) return null
  for (const folder of ['.config', '.local', 'Library', '.pi', '.claude'])
    if (within(value, join(real, folder))) return null
  return value
}

/**
 * Where this process finds its service. A packaged app uses only the install
 * roots and ignores both variables; an unpackaged build uses only the two
 * variables, so a dev or e2e Desktop never finds the owner's real service.
 */
export function localDaemonLocation(input: LocalDaemonLocationInput): LocalDaemonLocationResult {
  if (input.isPackaged) {
    if (!input.roots.on) return { on: false, reason: input.roots.reason }
    const { configDir, stateDir } = input.roots.roots
    return { on: true, location: { kind: 'service', configDir, stateDir } }
  }
  const socketValue = input.env[LOCAL_DAEMON_SOCKET_ENV]
  const configValue = input.env[LOCAL_DAEMON_CONFIG_ENV]
  if (socketValue === undefined && configValue === undefined)
    return { on: false, reason: 'Development builds never look for the Phosphor service.' }
  const socket = scratchPath(socketValue, input.home)
  const configDir = scratchPath(configValue, input.home)
  if (!socket || !configDir || Buffer.byteLength(socket) > LOCAL_LIMITS.socketPathBytes)
    return {
      on: false,
      reason: `${LOCAL_DAEMON_SOCKET_ENV} and ${LOCAL_DAEMON_CONFIG_ENV} must be scratch paths outside your home folders.`,
    }
  return { on: true, location: { kind: 'dev', socket, configDir } }
}

/** A daemon sidecar: a regular file this user owns with no group or other bits, bounded. */
function readSidecar<T>(path: string, uid: number | undefined, parse: (v: unknown) => T | null) {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || !isOwnerPrivate(info, uid) || info.size > SIDECAR_MAX_BYTES) return null
    const buffer = Buffer.alloc(SIDECAR_MAX_BYTES + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > SIDECAR_MAX_BYTES) return null
    return parse(JSON.parse(buffer.subarray(0, size).toString('utf8')))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The service's machine id and local public key, or null until `setup --local` wrote them. */
export function readLocalIdentity(configDir: string, uid: number | undefined) {
  return readSidecar<LocalIdentityFile>(
    join(configDir, HOST_SIDECARS.localIdentity),
    uid,
    parseLocalIdentityFile,
  )
}

/**
 * The socket to dial now. A service names it in `local.json`, which exists
 * only while its socket accepts connections, so a missing or foreign file
 * means "not serving yet" and the caller retries.
 */
export function localSocketPath(
  location: LocalDaemonLocation,
  machineId: string,
  uid: number | undefined,
): string | null {
  if (location.kind === 'dev') return location.socket
  const run = readSidecar(join(location.stateDir, HOST_SIDECARS.localRun), uid, parseLocalRunFile)
  return run?.machineId === machineId ? run.socket : null
}
