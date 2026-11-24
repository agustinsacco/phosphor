import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { errnoIs } from '../fs-safety'

/** Create only a missing link. Never rename or unlink an existing user's command. */
export function ensureLauncher(
  home: string,
  uid = process.getuid?.(),
): 'created' | 'ours' | 'foreign' {
  if (uid === undefined || resolve(home) !== home || home === '/')
    throw new Error('Unsafe launcher home.')
  const bin = join(home, '.local/bin')
  for (const dir of [join(home, '.local'), bin]) {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error
    }
    const info = lstatSync(dir)
    if (!info.isDirectory() || info.uid !== uid || info.mode & 0o022)
      throw new Error('Unsafe launcher directory.')
  }
  const path = join(bin, 'phosphor')
  const target = join(home, '.local/lib/phosphor-host/current/bin/phosphor')
  try {
    symlinkSync(target, path)
    return 'created'
  } catch (error) {
    if (!errnoIs(error, 'EEXIST')) throw error
  }
  return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target ? 'ours' : 'foreign'
}
