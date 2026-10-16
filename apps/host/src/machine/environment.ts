import { dirname, join } from 'node:path'
import { isForwardedEnvName } from '@phosphor/session-runtime/pi/forwarded-env'

/**
 * pi's environment on a Host is built, not inherited. A foreground shell,
 * `env -i` and a service manager must all give pi the same variables, and
 * nothing the Host process happened to inherit may reach the agent unasked.
 */

/** Passed whenever set: identity, locale, and the XDG layout pi's paths follow. */
const BASE_NAMES = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
])
// TERM is left out on purpose: a Host run by a service manager must behave
// exactly like one started from a terminal.

/** Loader and shell hooks. Never passed, even when the config names them. */
const DENIED_PREFIXES = ['LD_', 'DYLD_']
const DENIED_NAMES = new Set([
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'PS4',
])

/** Authority over other systems: passed only when the config names it. */
export const AMBIENT_NAMES = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_AGENT_INFO',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'KRB5CCNAME',
])

const UNIX_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']

export function platformPath(platform: NodeJS.Platform): string[] {
  return platform === 'darwin' ? ['/opt/homebrew/bin', ...UNIX_PATH] : UNIX_PATH
}

export function isDeniedName(name: string): boolean {
  const upper = name.toUpperCase()
  return DENIED_NAMES.has(upper) || DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/** Why the config may not pass this name to pi, or null when it may. */
export function passRefusal(name: string): string | null {
  if (name.toUpperCase() === 'PATH')
    return 'PATH is built by the Host: list folders in /environment/path'
  if (isDeniedName(name)) return `${name} is never passed to pi`
  return null
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PROXY/i
const MIN_SECRET_LENGTH = 8

/**
 * Worth redacting: a credential-like name, a provider variable, or anything
 * the config passes by name, since the operator chose to hand it to pi.
 * pi's own `PI_` variables are settings and paths, not credentials, and
 * redacting them would blank out every session path in a log line. A `PI_`
 * variable that does hold a secret still matches the name rule.
 */
function isSecret(name: string, value: string, passed: boolean): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false
  if (passed || SECRET_NAME.test(name)) return true
  return isForwardedEnvName(name) && !name.toUpperCase().startsWith('PI_')
}

export interface PiEnvironment {
  env: Record<string, string>
  /** Sorted names pi receives. Safe to print; values never are. */
  names: string[]
  /** Ambient-authority names present because the config passed them. */
  ambient: string[]
  /** Names the config passes that this Host's environment does not set. */
  unset: string[]
  /** Values to redact from every report and log line, longest first. */
  secrets: string[]
}

/**
 * Base names, `LC_*`, the provider names Desktop imports from a login shell,
 * and the config's `pass` list, minus the hooks above. PATH is never
 * inherited: it is node's directory, then the config's folders, then
 * $HOME/.local/bin and the platform defaults. Path-shaping variables (`PI_CODING_AGENT_DIR`, `XDG_*`)
 * come only from the Host's own environment, so the Host and pi agree on
 * where sessions live.
 */
export function buildPiEnvironment(input: {
  hostEnv: NodeJS.ProcessEnv
  pass?: readonly string[]
  path?: readonly string[]
  nodePath?: string | null
  platform: NodeJS.Platform
}): PiEnvironment {
  const pass = new Set(input.pass ?? [])
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.hostEnv)) {
    if (value === undefined || isDeniedName(name)) continue
    const standard = BASE_NAMES.has(name) || name.startsWith('LC_') || isForwardedEnvName(name)
    if (pass.has(name) || standard) env[name] = value
  }
  // Built last, so an inherited or passed PATH never survives.
  const node = input.nodePath ? [dirname(input.nodePath)] : []
  env.PATH = [
    ...new Set([
      ...node,
      ...(input.path ?? []),
      ...(env.HOME ? [join(env.HOME, '.local/bin')] : []),
      ...platformPath(input.platform),
    ]),
  ].join(':')
  const names = Object.keys(env).sort()
  const secrets = new Set(
    names.filter((name) => isSecret(name, env[name]!, pass.has(name))).map((name) => env[name]!),
  )
  return {
    env,
    names,
    ambient: names.filter((name) => AMBIENT_NAMES.has(name)),
    unset: [...pass].filter((name) => input.hostEnv[name] === undefined).sort(),
    secrets: [...secrets].sort((a, b) => b.length - a.length),
  }
}

/**
 * Hide every occurrence of every secret value, overlapping ones included:
 * each run of hidden characters becomes one `[redacted]`. When the text was
 * cut short (`cut`), a trailing piece of a secret is hidden too, since the
 * cut kept that secret's first characters.
 */
export function redact(text: string, secrets: readonly string[], cut = false): string {
  const hidden = new Uint8Array(text.length)
  for (const secret of secrets) {
    if (secret.length > 0) hide(text, secret, hidden, cut)
  }
  let out = ''
  for (let start = 0, end = 0; start < text.length; start = end) {
    while (end < text.length && hidden[end] === hidden[start]) end++
    out += hidden[start] ? '[redacted]' : text.slice(start, end)
  }
  return out
}

/**
 * Mark every occurrence of `secret` in `text`, overlapping ones included,
 * and with `cut`, the start of `secret` that ends `text`. One
 * Knuth-Morris-Pratt pass: the cost is the two lengths added, never
 * multiplied, however the text and the secret repeat.
 */
function hide(text: string, secret: string, hidden: Uint8Array, cut: boolean): void {
  // border[i]: the length of the longest proper start of secret[0..i] that also ends it.
  const border = new Int32Array(secret.length)
  for (let i = 1, length = 0; i < secret.length; i++) {
    while (length > 0 && secret.charCodeAt(i) !== secret.charCodeAt(length)) {
      length = border[length - 1]!
    }
    if (secret.charCodeAt(i) === secret.charCodeAt(length)) length++
    border[i] = length
  }
  // How much of the secret's start ends the text read so far.
  let matched = 0
  let filled = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    while (matched > 0 && code !== secret.charCodeAt(matched)) matched = border[matched - 1]!
    if (code === secret.charCodeAt(matched)) matched++
    if (matched === secret.length) {
      // Overlapping occurrences: fill only what the previous one left.
      hidden.fill(1, Math.max(i + 1 - secret.length, filled), i + 1)
      filled = i + 1
      matched = border[matched - 1]!
    }
  }
  if (cut) hidden.fill(1, text.length - matched)
}
