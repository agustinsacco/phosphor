import { constants } from 'node:fs'
import { access, open, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { errorText } from '@phosphor/shared/errors'
import { MIN_PI_VERSION } from '@phosphor/shared/models'
import { compareVersions, extractVersion } from '@phosphor/session-runtime/pi/versions'
import { EXIT, fail, pass, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { errnoIs } from '../fs-safety'
import { probe, probeFailure, type ProbeEnvironment } from './probe'

/** The Host's own floor, and pi.node's when pi's package declares none. */
export const MIN_NODE_VERSION = '22.19.0'
const PI_VERSION_TIMEOUT_MS = 15_000

/** How to start pi: node with the cli as its first argument, or pi itself. */
export interface PiLaunch {
  binaryPath: string
  prefixArgs: string[]
  version: string
}

/**
 * A node version as npm orders one: major, minor, patch, then 1 for a
 * release or 0 for a prerelease, which sorts just below its release.
 */
type Version = readonly [number, number, number, 0 | 1]

type Test = (version: Version) => boolean

const compare = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]

/**
 * npm's grammar, strictly: a number has no leading zero (and nine digits at
 * most here, so every bound worked out from one is an exact integer), and a
 * prerelease identifier is a number, or letters, digits and hyphens.
 */
const NUMBER = String.raw`(0|[1-9]\d{0,8})`
const IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)`
const VERSION = new RegExp(
  String.raw`^v?${NUMBER}\.${NUMBER}\.${NUMBER}(-${IDENTIFIER}(?:\.${IDENTIFIER})*)?$`,
)
/** npm reads no version longer than this. */
const MAX_VERSION_LENGTH = 256

/** One npm comparator: `>=22.19.0`, `^24`, `<23`, `~22.4`. */
const COMPARATOR = new RegExp(
  String.raw`^(>=|<=|>|<|=|\^|~)?v?${NUMBER}(?:\.${NUMBER})?(?:\.${NUMBER})?$`,
)

/**
 * One comparator, as npm reads it to check engines (`includePrerelease`).
 * A partial version such as `24` or `22.19` fills with zeros and, as a
 * lower bound, admits that version's prereleases (`>=24.0.0-0`), except
 * after `~`. Every upper bound npm works out stops before the next
 * version's prereleases (`<25.0.0-0`).
 */
function comparator(token: string): Test | null {
  const match = COMPARATOR.exec(token)
  if (!match) return null
  const major = Number(match[2])
  const minor = Number(match[3] ?? 0)
  const patch = Number(match[4] ?? 0)
  const full = match[4] !== undefined
  const release: Version = [major, minor, patch, 1]
  const lowest: Version = [major, minor, patch, 0]
  // Just past the parts given: 22 gives 23.0.0-0; 22.19 and 22.19.3 give 22.20.0-0.
  const next: Version = match[3] === undefined ? [major + 1, 0, 0, 0] : [major, minor + 1, 0, 0]
  const from = (floor: Version) => (version: Version) => compare(version, floor) >= 0
  const before = (ceiling: Version) => (version: Version) => compare(version, ceiling) < 0
  const within = (floor: Version, ceiling: Version) => (version: Version) =>
    from(floor)(version) && before(ceiling)(version)
  switch (match[1]) {
    case '>=':
      return from(full ? release : lowest)
    case '<':
      return before(full ? release : lowest)
    case '>':
      return full ? (version) => compare(version, release) > 0 : from(next)
    case '<=':
      return full ? (version) => compare(version, release) <= 0 : before(next)
    case '~':
      return within(release, next)
    case '^': {
      const ceiling: Version =
        major > 0 || match[3] === undefined
          ? [major + 1, 0, 0, 0]
          : minor > 0 || !full
            ? [0, minor + 1, 0, 0]
            : [0, 0, patch + 1, 0]
      return within(full && major > 0 ? release : lowest, ceiling)
    }
    default:
      return full ? (version) => compare(version, release) === 0 : within(lowest, next)
  }
}

/**
 * Does `version` satisfy pi's `engines.node`, as npm would answer? Reads
 * npm's comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`, on one to three
 * numbers of up to nine digits), joined by spaces and `||`, and returns
 * null when any part is another form, such as `22.x` or `18 - 22`: the
 * check then fails rather than guess. One such part is enough, even beside
 * an alternative that matches, as npm refuses a whole range when one part
 * is invalid. A version npm would not read satisfies nothing, nor does one
 * with a number past nine digits.
 */
export function satisfiesEngines(version: string, range: string): boolean | null {
  const alternatives = range.split('||').map((alternative) =>
    alternative
      .trim()
      // `>= 22` is `>=22`, as npm reads it; `> = 22` is not.
      .replace(/(>=|<=|>|<|=|\^|~)\s+(?=v?\d)/g, '$1')
      .split(/\s+/)
      .map(comparator),
  )
  const readable = (tests: (Test | null)[]): tests is Test[] => tests.every((test) => test !== null)
  if (!alternatives.every(readable)) return null
  const parsed = version.length <= MAX_VERSION_LENGTH ? VERSION.exec(version) : null
  if (!parsed) return false
  const node: Version = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3]), parsed[4] ? 0 : 1]
  return alternatives.some((tests) => tests.every((test) => test(node)))
}

export function checkHostNode(version: string): Check {
  return satisfiesEngines(version, `>=${MIN_NODE_VERSION}`)
    ? pass('host-node', `node ${version} runs the Host`)
    : fail('host-node', `node ${version} runs the Host, which needs ${MIN_NODE_VERSION} or newer`)
}

/** Why `path` is not an executable regular file, or null when it is one. */
async function notExecutable(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return 'is not a file'
    await access(path, constants.X_OK)
    return null
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return 'does not exist'
    return errnoIs(error, 'EACCES') ? 'is not executable' : errorText(error)
  }
}

/** The first executable file called `name` in a PATH value. Relative entries never match. */
export async function which(name: string, pathValue: string): Promise<string | null> {
  for (const dir of pathValue.split(delimiter)) {
    if (isAbsolute(dir) && (await notExecutable(join(dir, name))) === null) return join(dir, name)
  }
  return null
}

/**
 * A `.js`, `.mjs` or `.cjs` file, or a `#!` line that names node. A file
 * that cannot be read is not a script: it can only run directly.
 */
export async function isNodeScript(path: string): Promise<boolean> {
  if (['.js', '.mjs', '.cjs'].includes(extname(path))) return true
  try {
    const handle = await open(path, 'r')
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0)
      const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
      return first.startsWith('#!') && /[/\s]node(\s|$)/.test(first)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

interface Manifest {
  name: string
  version?: string
  engines?: { node?: unknown }
}

/**
 * pi's own package.json, for an npm install: the nearest named package.json
 * above pi's real path, when that package is pi. A native build has none.
 */
async function piManifest(piPath: string): Promise<Manifest | null> {
  for (let dir = dirname(piPath), depth = 0; depth < 6; dir = dirname(dir), depth++) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest?.name === 'string') {
        return /(^|\/)pi-coding-agent$/.test(manifest.name) ? (manifest as Manifest) : null
      }
    } catch {
      // No manifest here, or not one worth reading: keep climbing.
    }
    if (dirname(dir) === dir) break
  }
  return null
}

async function realExecutable(path: string): Promise<{ real: string } | { problem: string }> {
  try {
    const real = await realpath(path)
    const problem = await notExecutable(real)
    return problem ? { problem: `${path} ${problem}` } : { real }
  } catch (error) {
    const missing = errnoIs(error, 'ENOENT')
    return { problem: `${path} ${missing ? 'does not exist' : errorText(error)}` }
  }
}

export async function versionOf(
  binaryPath: string,
  args: string[],
  environment: ProbeEnvironment,
  timeoutMs: number,
): Promise<{ version: string } | { problem: string }> {
  const { env, secrets } = environment
  const result = await probe(binaryPath, args, { env, secrets, timeoutMs })
  const version = result.code === 0 ? extractVersion(`${result.stdout}\n${result.stderr}`) : null
  return version
    ? { version }
    : { problem: `${[binaryPath, ...args].join(' ')} failed${probeFailure(result)}` }
}

/**
 * Validate the pinned node and pi and work out how to start pi. pi 1.2.0
 * is `dist/bundle/cli.js` with a node shebang, so it runs as node plus the
 * cli: the shebang would otherwise look node up on a PATH the Host builds.
 */
export async function resolvePi(
  pi: HostConfigV1['pi'],
  environment: ProbeEnvironment,
  options: { timeoutMs?: number } = {},
): Promise<{ checks: Check[]; launch: PiLaunch | null }> {
  const timeoutMs = options.timeoutMs ?? PI_VERSION_TIMEOUT_MS
  const checks: Check[] = []
  const done = (check: Check) => ({ checks: [...checks, check], launch: null })

  let piPath: string
  try {
    piPath = await realpath(pi.executable)
    if (!(await stat(piPath)).isFile()) return done(fail('pi', `${pi.executable} is not a file`))
  } catch (error) {
    const missing = errnoIs(error, 'ENOENT')
    return done(fail('pi', `${pi.executable} ${missing ? 'does not exist' : errorText(error)}`))
  }
  const script = await isNodeScript(piPath)
  const manifest = await piManifest(piPath)

  let node: string | null = null
  if (pi.node) {
    const resolved = await realExecutable(pi.node)
    if ('problem' in resolved) return done(fail('pi-node', resolved.problem))
    const run = await versionOf(resolved.real, ['--version'], environment, timeoutMs)
    if ('problem' in run) return done(fail('pi-node', run.problem))
    // pi's own engines.node when it declares one, the Host's floor when it does not.
    const declared = manifest?.engines?.node
    if (declared !== undefined && typeof declared !== 'string') {
      // npm reads no range from a number or a list: its engines check fails for 22 too.
      return done(fail('pi-node', "pi's engines.node is not a range: it is not a string"))
    }
    const range = declared === undefined ? `>=${MIN_NODE_VERSION}` : declared.trim()
    const fits = satisfiesEngines(run.version, range)
    if (fits === null) {
      return done(fail('pi-node', `pi's engines.node "${range}" is a range this Host cannot read`))
    }
    if (!fits) {
      return done(
        fail('pi-node', `${resolved.real} is node ${run.version}; pi needs node ${range}`),
      )
    }
    node = resolved.real
    checks.push(pass('pi-node', `${node} ${run.version} (pi needs node ${range})`))
  }
  if (script && !node) {
    return done(
      fail('pi', `${piPath} is a Node script: set /pi/node to the node that runs it`, EXIT.config),
    )
  }
  if (!script) {
    const problem = await notExecutable(piPath)
    if (problem) return done(fail('pi', `${piPath} ${problem}`))
  }

  const launch =
    script && node
      ? { binaryPath: node, prefixArgs: [piPath] }
      : { binaryPath: piPath, prefixArgs: [] }
  const run = await versionOf(
    launch.binaryPath,
    [...launch.prefixArgs, '--version'],
    environment,
    timeoutMs,
  )
  if ('problem' in run) return done(fail('pi', run.problem))
  if (compareVersions(run.version, MIN_PI_VERSION) < 0) {
    return done(
      fail('pi', `${piPath} is pi ${run.version}; Phosphor needs ${MIN_PI_VERSION} or newer`),
    )
  }
  if (manifest?.version && manifest.version !== run.version) {
    return done(
      fail('pi', `${piPath} reports ${run.version}, but its package.json says ${manifest.version}`),
    )
  }
  checks.push(pass('pi', `${piPath} ${run.version}${script ? ', started with node' : ''}`))
  return { checks, launch: { ...launch, version: run.version } }
}

/** git must be on pi's PATH: sessions, worktrees and the directives all use it. */
export async function checkGit(
  environment: ProbeEnvironment,
): Promise<{ check: Check; git: string | null }> {
  const path = environment.env.PATH ?? ''
  const git = await which('git', path)
  if (!git) return { check: fail('git', `git is not on pi's PATH (${path})`), git: null }
  const run = await versionOf(git, ['--version'], environment, 10_000)
  if ('problem' in run) return { check: fail('git', run.problem), git: null }
  return { check: pass('git', `${git} ${run.version}`), git }
}
