import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/**
 * File mechanics for the account vault: where its files live, an atomic
 * user-only write, existence by lstat, and removal. Which file holds a
 * credential, and when one may be read or replaced, is vault-token.ts.
 */

export interface VaultPaths {
  readonly dir: string
  readonly profile: string
  /** The encrypted token. */
  readonly token: string
  /** The plain token, used only on Linux without a keyring. */
  readonly plain: string
}

export interface VaultFileContext {
  readonly paths: VaultPaths
  readonly platform: NodeJS.Platform
  readonly log: (message: string) => void
}

export function vaultPaths(dir: string): VaultPaths {
  return {
    dir,
    profile: join(dir, 'profile.json'),
    token: join(dir, 'session.bin'),
    plain: join(dir, 'session.txt'),
  }
}

/** A fresh 0600 temp file renamed over `path`, in a 0700 directory; the temp never outlives a failure. */
export function writeVaultFile(
  context: VaultFileContext,
  path: string,
  data: string | Buffer,
): void {
  const { dir } = context.paths
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Every file is attempted whatever the other did; any failure is thrown after. */
export function clearVaultFiles(context: VaultFileContext): void {
  const { paths } = context
  const failures: string[] = []
  // The credential first: if only one goes, it should be the secret.
  for (const path of [paths.token, paths.plain, paths.profile, join(paths.dir, 'avatar.json')]) {
    try {
      rmSync(path, { force: true })
    } catch (error) {
      failures.push(`${basename(path)} (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
  }
  if (failures.length > 0) throw new Error(`could not delete ${failures.join(' and ')}`)
}

/** By lstat: a link counts as present and is never followed. */
export function vaultFileExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Off Linux a plain token is only ever a copy from a Linux machine, never read. */
export function removeCopiedPlain(context: VaultFileContext): void {
  if (context.platform !== 'linux' && vaultFileExists(context.paths.plain)) {
    rmSync(context.paths.plain, { force: true })
    context.log('removed a plain sign-in file copied from Linux')
  }
}

/** False when the plain path is still there: rmSync refuses a directory, so rmdir is tried too. */
export function removeUnsafePlain(context: VaultFileContext): boolean {
  try {
    rmSync(context.paths.plain, { force: true })
  } catch {
    try {
      rmdirSync(context.paths.plain)
    } catch {
      return false
    }
  }
  return true
}
