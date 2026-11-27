import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { errnoIs } from '../fs-safety'

/** A pathless requirement shared by all installers, independent of the caller's XDG root. */
export const BRAIN_COMPATIBILITY_PIN = '.brain-required'
export const BRAIN_COMPATIBILITY_MESSAGE = 'This install requires a qualified Host Brain bundle.'

export function statIfPresent(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (!errnoIs(error, 'ENOENT')) throw error
    return undefined
  }
}

// Check parents first: a dangling or hostile link is not proof that state is absent.
function safeStateFolder(path: string): boolean {
  if (path === '/') return true
  if (!safeStateFolder(dirname(path))) return false
  const info = statIfPresent(path)
  if (!info) return false
  if (!info.isDirectory()) throw new Error('Unsafe Host state directory.')
  return true
}

/** Presence is enough to stop an ordinary replacement; a malformed pin cannot opt out. */
export function requiresBrainCompatibility(lib: string, home: string, state: string): boolean {
  if (statIfPresent(join(lib, BRAIN_COMPATIBILITY_PIN))) return true
  return [resolve(state), resolve(hostStateDirectory({}, home))].some(
    (path) =>
      safeStateFolder(path) &&
      ['brain', 'brain-handover'].some((name) => statIfPresent(join(path, name)) !== undefined),
  )
}
