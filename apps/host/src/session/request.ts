import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { CreateSessionOptions } from '@phosphor/shared/models'
import type { ThinkingLevel } from '@phosphor/shared/rpc'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { pointer, type ConfigError } from '../config/schema'
import { errnoIs } from '../fs-safety'
import { confineRemovedToRoots, confineToRoots } from '../machine/repositories'

/**
 * The only shape a caller can use to start or resume a Host session. pi's
 * executable, environment, extensions and system prompt are the Host's own,
 * never a caller's.
 */
export interface HostSessionRequest {
  /** Absolute; it must resolve inside a configured repository. */
  repository: string
  /** To resume: a `.jsonl` file directly inside pi's session folder for `repository`. */
  sessionPath?: string
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  /** Up to 120 characters: no control or text-direction characters, no leading `-`. */
  name?: string
}

export type ParsedRequest =
  { ok: true; options: CreateSessionOptions } | { ok: false; errors: ConfigError[] }

const FIELDS = ['repository', 'sessionPath', 'provider', 'model', 'thinkingLevel', 'name']
/** A deletion names a session file and nothing else. */
const DELETION_FIELDS = ['repository', 'sessionPath']
/** Spawn controls the Host sets itself. Named, so the refusal says why. */
const HOST_OWNED = [
  'env',
  'binaryPath',
  'prefixArgs',
  'extensions',
  'appendSystemPrompt',
  'cwd',
  'forkFrom',
  'sessionId',
]
// Each starts with a letter or digit, so no value can become one of pi's flags.
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const NAME_LIMIT = 120
// Control characters, line and paragraph separators, and text-direction overrides.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u
const OUTSIDE = "must be in pi's session folder for this repository"

/**
 * Check a request and resolve its paths. Every problem is reported, each at
 * its JSON pointer, and no message repeats a value from the request. The
 * repository is resolved to its real path first, so `..`, a symlink that
 * escapes and `/repo2` against `/repo` all fail. A session file must be a
 * regular file in pi's own folder for that repository: otherwise `--session`
 * would let pi append to any file. A deletion takes the repository and the
 * session file, both required, and nothing else.
 */
export async function parseSessionRequest(
  value: unknown,
  roots: readonly string[],
  options: { deleting?: boolean } = {},
): Promise<ParsedRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'must be an object' }] }
  }
  const request = value as Record<string, unknown>
  const errors: ConfigError[] = []
  const fail = (key: string, message: string) => errors.push({ pointer: pointer(key), message })
  const fields = options.deleting ? DELETION_FIELDS : FIELDS
  for (const key of Object.keys(request)) {
    if (HOST_OWNED.includes(key)) fail(key, 'is set by the Host, never by a request')
    else if (!fields.includes(key)) fail(key, 'is not a request field')
  }
  // Own fields only: nothing a prototype carries counts as part of a request.
  const own = (key: string): unknown => (Object.hasOwn(request, key) ? request[key] : undefined)
  // A field this kind of request does not take was refused above, and is read no further.
  const text = (key: string): string | undefined => {
    const field = fields.includes(key) ? own(key) : undefined
    if (field === undefined || typeof field === 'string') return field
    fail(key, 'must be a string')
    return undefined
  }

  const parsed: CreateSessionOptions = { workspacePath: '' }
  const provider = text('provider')
  if (provider !== undefined) {
    if (PROVIDER.test(provider)) parsed.provider = provider
    else fail('provider', 'must be a letter or digit, then up to 63 letters, digits, ., _ or -')
  }
  const model = text('model')
  if (model !== undefined) {
    if (MODEL.test(model)) parsed.model = model
    else fail('model', 'must be a letter or digit, then up to 127 letters, digits or ._:/@+-')
  }
  const thinkingLevel = text('thinkingLevel')
  if (thinkingLevel !== undefined) {
    if ((ALL_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
      parsed.thinkingLevel = thinkingLevel
    } else fail('thinkingLevel', `must be one of ${ALL_THINKING_LEVELS.join(', ')}`)
  }
  const name = text('name')
  if (name !== undefined) {
    if (name.length === 0 || name.length > NAME_LIMIT) fail('name', 'must be 1 to 120 characters')
    else if (UNPRINTABLE.test(name))
      fail('name', 'must not hold control or text-direction characters')
    else if (name.startsWith('-')) fail('name', 'must not start with -')
    else parsed.name = name
  }

  // The paths last: they are the checks that read the disk.
  const repository = text('repository')
  if (repository === undefined) {
    if (own('repository') === undefined) fail('repository', 'is required')
  } else {
    const problem = await repositoryProblem(repository, roots, options.deleting === true)
    if (typeof problem === 'string') fail('repository', problem)
    else parsed.workspacePath = problem.real
  }
  const session = text('sessionPath')
  if (session === undefined) {
    if (options.deleting && own('sessionPath') === undefined) {
      fail('sessionPath', 'is required')
    }
  } else if (parsed.workspacePath) {
    const problem = await sessionProblem(session, parsed.workspacePath)
    if (typeof problem === 'string') fail('sessionPath', problem)
    else parsed.sessionPath = problem.real
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, options: parsed }
}

async function repositoryProblem(
  path: string,
  roots: readonly string[],
  deleting: boolean,
): Promise<string | { real: string }> {
  if (!isAbsolute(path)) return 'must be an absolute path'
  // One answer for missing and outside, so nothing is said about other folders.
  const real = await confineToRoots(path, roots)
  if (!real) {
    // A worktree removed outside Phosphor leaves its session files behind,
    // and its lane must still be deletable. Only deletion skips the folder.
    const removed = deleting ? await confineRemovedToRoots(path, roots) : null
    return removed ? { real: removed } : 'must be an existing folder inside a configured repository'
  }
  const folder = await stat(real).then(
    (info) => info.isDirectory(),
    () => false,
  )
  return folder ? { real } : 'must be a folder'
}

async function sessionProblem(path: string, workspace: string): Promise<string | { real: string }> {
  if (!isAbsolute(path)) return 'must be an absolute path'
  if (!/.\.jsonl$/.test(basename(path))) return 'must name a .jsonl file'
  // The folder first: a file anywhere else gets one answer, whether it exists or not.
  let folder: string
  try {
    const [given, expected] = await Promise.all([
      realpath(dirname(path)),
      realpath(sessionDirForCwd(workspace)),
    ])
    if (given !== expected) return OUTSIDE
    folder = given
  } catch {
    return OUTSIDE
  }
  const real = join(folder, basename(path))
  let info
  try {
    info = await lstat(real)
  } catch (error) {
    const missing = errnoIs(error, 'ENOENT')
    return missing ? 'does not exist' : 'cannot be read'
  }
  if (info.isSymbolicLink()) return 'must not be a symlink'
  return info.isFile() ? { real } : 'must be a file'
}
