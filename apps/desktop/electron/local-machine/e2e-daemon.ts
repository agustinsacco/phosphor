import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { HOST_SIDECARS, parseOwnerClientsFile } from '@phosphor/shared/host-local'
import { isInside, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { readBounded } from '@phosphor/session-runtime/host-install/files'
import { log } from '../debug-log'
import type { OwnerKey } from '../daemon/owner-key'
import type { LocalDaemonAccess } from './mode'
import { LOCAL_DAEMON_CONFIG_ENV, LOCAL_DAEMON_SOCKET_ENV, localDaemonLocation } from './transport'

/**
 * The e2e path into M3's launch gate: an unpackaged Desktop with an
 * isolated userData can be pointed at a fixture daemon
 * (`apps/desktop/e2e/fixtures/local-daemon.ts`) and run in daemon mode. The
 * owner key is a plain PEM in the test's scratch folder, so neither the
 * Keychain nor safeStorage is touched. Inert in a packaged app and whenever
 * any of the four variables is missing.
 */

/** Unpackaged only: a 0600 PKCS#8 Ed25519 PEM whose public half `owner-clients.json` pairs. */
export const E2E_OWNER_KEY_ENV = 'PHOSPHOR_E2E_OWNER_KEY'

const KEY_MAX_BYTES = 8192
const CLIENTS_MAX_BYTES = 64 * 1024

export interface E2eDaemonInput {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  /** The real HOME (`os.homedir()`). */
  home: string
  uid: number | undefined
  /** Resolved folders a test's scratch may live in (the system temp folders). */
  scratchRoots: readonly string[]
}

/** `reason` is null when nothing asked for the hook, so a normal launch logs nothing. */
export type E2eDaemonDecision =
  { on: true; access: LocalDaemonAccess } | { on: false; reason: string | null }

const HOOK_ENV = [LOCAL_DAEMON_SOCKET_ENV, LOCAL_DAEMON_CONFIG_ENV, E2E_OWNER_KEY_ENV] as const

/** `path` resolved, when it exists and lies inside one of `roots`. */
function inScratch(path: string, roots: readonly string[]): string | null {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return null
  }
  return roots.some((root) => real !== root && isInside(root, real)) ? real : null
}

function privateFile(path: string, uid: number | undefined): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && isOwnerPrivate(info, uid)
  } catch {
    return false
  }
}

/** Whether this launch runs in daemon mode against a test's fixture daemon, and why not. */
export function e2eDaemonAccess(input: E2eDaemonInput): E2eDaemonDecision {
  if (input.isPackaged) return { on: false, reason: null }
  const { env } = input
  if (HOOK_ENV.every((name) => env[name] === undefined)) return { on: false, reason: null }
  const missing = [...HOOK_ENV, 'PHOSPHOR_TEST_USER_DATA'].filter((name) => !env[name])
  if (missing.length > 0) return { on: false, reason: `${missing.join(', ')} not set.` }
  const location = localDaemonLocation({
    isPackaged: false,
    env,
    home: input.home,
    roots: { on: false, reason: 'Unpackaged builds never read the install roots.' },
  })
  if (!location.on) return { on: false, reason: location.reason }
  if (
    location.location.kind !== 'dev' ||
    !inScratch(location.location.configDir, input.scratchRoots)
  )
    return { on: false, reason: `${LOCAL_DAEMON_CONFIG_ENV} must be inside a scratch folder.` }
  const keyPath = inScratch(env[E2E_OWNER_KEY_ENV] ?? '', input.scratchRoots)
  if (!keyPath || !privateFile(keyPath, input.uid))
    return {
      on: false,
      reason: `${E2E_OWNER_KEY_ENV} must name a 0600 key file inside a scratch folder.`,
    }
  const { configDir } = location.location
  return {
    on: true,
    access: {
      location: location.location,
      // A rejection, never a throw: the connection treats it as a failed grant and retries.
      ownerKey: () => Promise.resolve().then(() => readE2eOwnerKey(keyPath, configDir, input.uid)),
    },
  }
}

/** The fixture's owner key, named by the `owner-clients.json` entry that pairs its public half. */
export function readE2eOwnerKey(
  keyPath: string,
  configDir: string,
  uid: number | undefined,
): OwnerKey {
  if (!privateFile(keyPath, uid)) throw new Error('The e2e owner key is not a private file.')
  const privateKey = createPrivateKey(readBounded(keyPath, KEY_MAX_BYTES))
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('The e2e owner key is not Ed25519.')
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x
  const clientsPath = join(configDir, HOST_SIDECARS.ownerClients)
  if (!privateFile(clientsPath, uid)) throw new Error('owner-clients.json is not a private file.')
  const clients = parseOwnerClientsFile(JSON.parse(readBounded(clientsPath, CLIENTS_MAX_BYTES)))
  const client = clients?.clients.find((entry) => entry.publicKey === publicKey)
  if (!client) throw new Error('The e2e owner key is not paired with the fixture daemon.')
  return {
    id: client.id,
    label: client.label,
    publicKey: client.publicKey,
    sign: (bytes) => new Uint8Array(sign(null, bytes, privateKey)),
  }
}

function systemScratchRoots(): string[] {
  const roots = new Set<string>()
  for (const folder of [tmpdir(), '/tmp'])
    try {
      roots.add(realpathSync.native(folder))
    } catch {
      // A platform without /tmp keeps the temp folder alone.
    }
  return [...roots]
}

/**
 * E1's gated hook, read once by the launch gate (`launch-gate.ts`), which
 * then decides daemon mode with its access. Logs why it stays off only when
 * a test asked for it.
 */
export function e2eDaemonHook(): E2eDaemonDecision {
  const decision = e2eDaemonAccess({
    isPackaged: app.isPackaged,
    env: process.env,
    home: homedir(),
    uid: process.getuid?.(),
    scratchRoots: systemScratchRoots(),
  })
  if (decision.on)
    log('local-machine', 'e2e daemon hook on', { socket: process.env[LOCAL_DAEMON_SOCKET_ENV] })
  else if (decision.reason) log('local-machine', 'e2e daemon hook inert', decision.reason)
  return decision
}
