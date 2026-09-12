import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * GUI-launched apps on macOS/Linux inherit a minimal PATH (`/usr/bin:/bin:…`),
 * not the one the user's shell builds. That breaks version managers — fnm,
 * nvm, asdf, volta — twice over:
 *
 *   1. `pi` itself isn't on the default PATH, so it can't be found.
 *   2. Even given an absolute path to `pi`, it starts with
 *      `#!/usr/bin/env node`, so *node* must also be on PATH or the process
 *      dies with "env: node: No such file or directory".
 *
 * So we resolve the login shell's PATH once and reuse it for every pi
 * subprocess, not just for discovery.
 */

let cachedPath: string | null = null
let inFlight: Promise<string | null> | null = null
let cachedShellEnv: Record<string, string> | null = null
let envInFlight: Promise<Record<string, string>> | null = null

/**
 * Env vars worth importing from the login shell, by prefix.
 *
 * A GUI launch inherits a minimal environment, so provider credentials the
 * user exported from their shell profile (`AWS_PROFILE`, `ANTHROPIC_API_KEY`,
 * ...) are simply absent. pi then fails to authenticate in a packaged build
 * while working fine under `npm run dev`, which inherits the terminal. This is
 * the same class of bug as the PATH problem above, and needs the same fix.
 *
 * An allowlist rather than a wholesale env import on purpose: copying every
 * shell variable would clobber Electron's own runtime vars and leak unrelated
 * shell state into the subprocess.
 */
const FORWARDED_ENV_PREFIXES = [
  'AWS_', // Bedrock: profile, region, keys, endpoint + cache overrides
  'ANTHROPIC_',
  'OPENAI_',
  'AZURE_',
  'GEMINI_',
  'GOOGLE_',
  'VERTEX_',
  'CLOUDFLARE_',
  'GROQ_',
  'MISTRAL_',
  'CEREBRAS_',
  'XAI_',
  'OPENROUTER_',
  'BASETEN_',
  'FIREWORKS_',
  'QWEN_',
  'PI_', // pi's own knobs, e.g. PI_CACHE_RETENTION
]

/** Exact names with no useful shared prefix. */
const FORWARDED_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']

function isForwardedEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    FORWARDED_ENV_NAMES.includes(upper) ||
    FORWARDED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  )
}

/** The user's login-shell PATH, or null when it can't be determined. */
export async function getLoginShellPath(): Promise<string | null> {
  if (cachedPath !== null) return cachedPath
  if (inFlight) return inFlight

  inFlight = resolveLoginShellPath()
    .then((value) => {
      cachedPath = value ?? ''
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function resolveLoginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return process.env.PATH ?? null

  const shell = process.env.SHELL || '/bin/zsh'
  // A login+interactive shell so rc files that set up version managers run.
  // `-i` matters for fnm/nvm, which are typically wired up in .zshrc.
  for (const args of [
    ['-lic', 'printf %s "$PATH"'],
    ['-lc', 'printf %s "$PATH"'],
  ]) {
    try {
      const { stdout } = await execFileAsync(shell, args, { timeout: 15_000 })
      const value = stdout.trim().split('\n').pop()?.trim()
      if (value && value.includes('/')) return value
    } catch {
      // try the next form
    }
  }
  return null
}

/**
 * Allowlisted provider/proxy vars exported by the user's login shell.
 *
 * Returns an empty object on Windows (GUI processes inherit the user
 * environment there) and whenever the shell can't be probed.
 */
export async function getLoginShellEnv(): Promise<Record<string, string>> {
  if (cachedShellEnv !== null) return cachedShellEnv
  if (envInFlight) return envInFlight

  envInFlight = resolveLoginShellEnv()
    .then((value) => {
      cachedShellEnv = value
      return value
    })
    .finally(() => {
      envInFlight = null
    })
  return envInFlight
}

async function resolveLoginShellEnv(): Promise<Record<string, string>> {
  if (process.platform === 'win32') return {}

  const shell = process.env.SHELL || '/bin/zsh'
  for (const args of [
    ['-lic', 'env -0'],
    ['-lc', 'env -0'],
  ]) {
    try {
      const { stdout } = await execFileAsync(shell, args, {
        timeout: 15_000,
        // Credentials are small, but rc-file chatter is unbounded.
        maxBuffer: 4 * 1024 * 1024,
      })
      const parsed = parseNulEnv(stdout)
      if (Object.keys(parsed).length > 0) return parsed
    } catch {
      // try the next form
    }
  }
  return {}
}

/**
 * Parse NUL-delimited `KEY=VALUE` records from `env -0`.
 *
 * NUL delimiting matters: values may legally contain newlines, so a
 * line-oriented parse would split one variable into several bogus ones.
 */
function parseNulEnv(stdout: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const record of stdout.split('\0')) {
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    // rc-file chatter fuses into the first record ('hello\nAWS_PROFILE=dev'),
    // so keep only what follows the last newline in the key.
    const rawName = record.slice(0, eq)
    const newline = rawName.lastIndexOf('\n')
    const name = newline === -1 ? rawName : rawName.slice(newline + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    if (!isForwardedEnvName(name)) continue
    result[name] = record.slice(eq + 1)
  }
  return result
}

/**
 * Environment for spawning pi: the caller's env with PATH upgraded to the
 * login shell's, so `#!/usr/bin/env node` resolves under a version manager,
 * plus allowlisted provider credentials the GUI launch didn't inherit.
 */
export async function piProcessEnv(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const [shellPath, shellEnv] = await Promise.all([getLoginShellPath(), getLoginShellEnv()])
  const base = { ...process.env } as Record<string, string>
  // Fill gaps only. An explicitly inherited value is more specific than the
  // shell profile's, so a terminal launch keeps whatever it was given.
  for (const [name, value] of Object.entries(shellEnv)) {
    if (base[name] === undefined) base[name] = value
  }
  // Windows has no login shell to consult (`getLoginShellPath` hands back the
  // inherited PATH), so there is nothing to merge — and merging would also
  // have to survive `C:` drive colons, which `dedupePath` used to split on.
  if (shellPath && process.platform !== 'win32') {
    // Prefer the shell's PATH, keeping any inherited entries as a fallback.
    const inherited = process.env.PATH ?? ''
    const merged = inherited ? `${shellPath}${pathDelimiter()}${inherited}` : shellPath
    base.PATH = dedupePath(merged)
  }
  return { ...base, ...extra }
}

/**
 * From `process.platform`, not `node:path`'s `delimiter`: the two agree in
 * production, but the tests fake the platform, and `delimiter` is baked in
 * from the HOST — on the Windows CI runner it is `;`, which made the POSIX
 * cases produce `/opt/bin;/usr/bin:/bin`.
 */
function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function dedupePath(path: string): string {
  const seen = new Set<string>()
  return path
    .split(pathDelimiter())
    .filter((entry) => entry && !seen.has(entry) && (seen.add(entry), true))
    .join(pathDelimiter())
}

/** Test seam: forget the cached PATH and shell env. */
export function resetShellPathCache(): void {
  cachedPath = null
  inFlight = null
  cachedShellEnv = null
  envInFlight = null
}
