import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_SIDECARS, type LocalModeFile } from '@phosphor/shared/host-local'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'
import { errnoIs, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'

/** A sidecar file's name beside `config.json` or in the state folder. */
export type SidecarName = (typeof HOST_SIDECARS)[keyof typeof HOST_SIDECARS]

export const SIDECAR_MAX_BYTES = 64 * 1024

export type SidecarRead<T> =
  | { readonly state: 'missing' }
  | { readonly state: 'ok'; readonly value: T }
  /** Not owner-only, a link, too large, not JSON, or refused by its parser. */
  | { readonly state: 'invalid'; readonly reason: string }

export interface SidecarOptions {
  /** The user running the Host; undefined refuses every sidecar. */
  readonly uid: number | undefined
  readonly maxBytes?: number
}

function ownerOnly(path: string, uid: number | undefined): string | null {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return 'not a plain file'
  return isOwnerPrivate(info, uid) ? null : 'not owner-only'
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The raw JSON object, or a reason it cannot be trusted. Both folder and file must be owner-only. */
function readRaw(
  directory: string,
  name: SidecarName,
  options: SidecarOptions,
): { raw: Record<string, unknown> } | { missing: true } | { reason: string } {
  const path = join(directory, name)
  try {
    const refused = ownerOnly(directory, options.uid) ?? ownerOnly(path, options.uid)
    if (refused) return { reason: refused }
    const raw: unknown = JSON.parse(readBounded(path, options.maxBytes ?? SIDECAR_MAX_BYTES))
    return record(raw) && Number.isSafeInteger(raw.version) ? { raw } : { reason: 'no version' }
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return { missing: true }
    return { reason: error instanceof SyntaxError ? 'not JSON' : 'unreadable' }
  }
}

/** One loader for every sidecar: owner-only, bounded, versioned, then the caller's parser. */
export function readSidecar<T>(
  directory: string,
  name: SidecarName,
  parse: (raw: Record<string, unknown>) => T | null,
  options: SidecarOptions,
): SidecarRead<T> {
  const read = readRaw(directory, name, options)
  if ('missing' in read) return { state: 'missing' }
  if ('reason' in read) return { state: 'invalid', reason: read.reason }
  const value = parse(read.raw)
  return value === null ? { state: 'invalid', reason: 'refused' } : { state: 'ok', value }
}

/**
 * Atomic owner-only (0600) write. Keys a newer Host wrote and this one does
 * not know (absent from `known` and `value`) are kept, so a rollback and
 * update round trip loses nothing.
 */
export function writeSidecar(
  directory: string,
  name: SidecarName,
  value: { readonly version: number } & Record<string, unknown>,
  options: SidecarOptions & { readonly known: readonly string[] },
): void {
  const refused = ownerOnly(directory, options.uid)
  if (refused) throw new Error(`${name}: the folder is ${refused}`)
  const read = readRaw(directory, name, options)
  const kept: Record<string, unknown> = {}
  if ('raw' in read)
    for (const [key, previous] of Object.entries(read.raw))
      if (!options.known.includes(key) && !(key in value)) kept[key] = previous
  const next = { ...kept, ...value }
  if (Buffer.byteLength(JSON.stringify(next)) + 1 > (options.maxBytes ?? SIDECAR_MAX_BYTES))
    throw new Error(`${name}: too large`)
  atomicRecord(join(directory, name), next, 0o600)
}

/** Missing means ordinary headless operation, even when its config folder is not private. */
export function readLocalMode(directory: string, uid: number | undefined): LocalModeFile | null {
  try {
    lstatSync(join(directory, HOST_SIDECARS.localMode))
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  }
  const result = readSidecar(
    directory,
    HOST_SIDECARS.localMode,
    (raw) =>
      raw.version === 1 &&
      typeof raw.enabledAt === 'string' &&
      typeof raw.shellEnvironment === 'boolean'
        ? { version: 1 as const, enabledAt: raw.enabledAt, shellEnvironment: raw.shellEnvironment }
        : null,
    { uid },
  )
  if (result.state !== 'ok') throw new Error('Local service marker is not usable.')
  return result.value
}
