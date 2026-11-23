import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const main = (url) => process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url
/** @returns {Record<string,string>} All accepted options are named strings. */
export const flags = (...names) =>
  /** @type {Record<string,string>} */ (
    parseArgs({ options: Object.fromEntries(names.map((k) => [k, { type: 'string' }])) }).values
  )
export const inside = (parent, child) => child.startsWith(parent + sep)
const refuse = () => {
  throw new Error('Refusing unsafe rehearsal root')
}

export function layout(root) {
  const home = join(root, 'home'),
    config = join(root, 'c', 'phosphor-host'),
    state = join(root, 's', 'phosphor-host')
  return {
    userData: join(root, 'user-data'),
    agent: join(root, 'agent'),
    home,
    config,
    state,
    socket: join(state, 'run/phosphor.sock'),
    launchAgents: join(home, 'Library/LaunchAgents'),
    units: join(root, 'c/systemd/user'),
    runtime: join(root, 'runtime'),
    ownerKey: join(root, 'owner-key.pem'),
  }
}

/** TMPDIR is user controlled. Never treat an arbitrary parent as the system temp directory. */
export function scratchDir(input) {
  if (
    !input ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    !/^r0-[A-Za-z0-9]{6}$/.test(basename(input))
  )
    refuse()
  const temp = realpathSync.native(tmpdir()),
    allowed = [realpathSync.native('/tmp')]
  if (process.platform === 'darwin')
    allowed.push(
      realpathSync.native(
        execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(),
      ),
    )
  const stat = lstatSync(input),
    root = realpathSync.native(input)
  if (
    !allowed.includes(temp) ||
    dirname(root) !== temp ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    inside(userInfo().homedir, root)
  )
    refuse()
  return root
}

/** Reject links (even dangling or internal ones) at every existing component below scratch. */
export function assertRoots(input, roots) {
  const root = scratchDir(input)
  checkDescendants(root, roots, input)
}

export function checkDescendants(root, roots, input = root) {
  for (const path of Object.values(roots)) {
    if (!isAbsolute(path) || resolve(path) !== path || !(inside(input, path) || inside(root, path)))
      refuse()
    const prefix = inside(input, path) ? input : root
    let actual = root
    for (const part of path.slice(prefix.length + 1).split(sep)) {
      actual = join(actual, part)
      const stat = lstatSync(actual, { throwIfNoEntry: false })
      if (stat && (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1))) refuse()
    }
  }
}

/** Call before any other run operation. A too-long socket would make the Host try its /tmp fallback. */
export function checkedLayout(input) {
  const root = scratchDir(input),
    roots = layout(root)
  assertRoots(root, roots)
  if (Buffer.byteLength(roots.socket) > 100) refuse()
  return { root, roots }
}

if (main(import.meta.url)) {
  try {
    checkedLayout(flags('scratch').scratch)
  } catch {
    console.error('Scratch assertion refused')
    process.exitCode = 99
  }
}
