import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { check } from '../validation'
import type { RepositoryIdentity } from './types'

/** Only newly added folders are home-confined; owner-configured roots remain unrestricted. */
export function validateRepositoryIdentity(identity: RepositoryIdentity): void {
  const { expected } = identity
  const home = realpathSync.native(identity.home)
  const full = realpathSync.native(expected.path)
  const rel = relative(home, full)
  const info = statSync(full)
  check(full === expected.path && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
  check(info.isDirectory() && info.dev === expected.dev && info.ino === expected.ino)
}
