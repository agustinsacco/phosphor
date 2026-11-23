import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isForwardedEnvName } from './forwarded-env'

const execFileAsync = promisify(execFile)

export interface ShellEnvironmentPorts {
  shell(): string
  run(
    shell: string,
    args: string[],
    limits: { timeoutMs: number; maxBytes?: number },
  ): Promise<string>
  now(): number
  accepts(name: string): boolean
}

const nodePorts: ShellEnvironmentPorts = {
  shell: () => process.env.SHELL || '/bin/zsh',
  now: Date.now,
  accepts: isForwardedEnvName,
  run: async (shell, args, { timeoutMs: timeout, maxBytes: maxBuffer }) =>
    (
      await execFileAsync(shell, args, {
        timeout,
        ...(maxBuffer === undefined ? {} : { maxBuffer }),
      })
    ).stdout,
}

/** A fresh, timestamped probe. The caller owns its cache lifetime; Desktop caches each half separately below. */
export async function captureShellEnvironment(ports: ShellEnvironmentPorts) {
  const [path, values] = await Promise.all([
    resolveLoginShellPath(ports),
    resolveLoginShellEnv(ports),
  ])
  if (!path && Object.keys(values).length === 0) return null
  return {
    path: path?.split(':').filter(Boolean) ?? [],
    values,
    at: ports.now(),
  }
}

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

/** The user's login-shell PATH, or null when it can't be determined. */
export async function getLoginShellPath(): Promise<string | null> {
  if (cachedPath !== null) return cachedPath
  if (inFlight) return inFlight

  inFlight = resolveLoginShellPath(nodePorts)
    .then((value) => {
      cachedPath = value ?? ''
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function resolveLoginShellPath(ports: ShellEnvironmentPorts): Promise<string | null> {
  const shell = ports.shell()
  // A login+interactive shell so rc files that set up version managers run.
  // `-i` matters for fnm/nvm, which are typically wired up in .zshrc.
  for (const args of [
    ['-lic', 'printf %s "$PATH"'],
    ['-lc', 'printf %s "$PATH"'],
  ]) {
    try {
      const stdout = await ports.run(shell, args, { timeoutMs: 15_000 })
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
 * Credentials need the same fix as PATH: a GUI launch inherits a minimal
 * environment, so what the user exported from their shell profile
 * (`AWS_PROFILE`, `ANTHROPIC_API_KEY`, ...) is simply absent, and pi fails to
 * authenticate in a packaged build while working fine under `npm run dev`,
 * which inherits the terminal. Only names `isForwardedEnvName` accepts come in.
 *
 * Returns an empty object whenever the shell can't be probed.
 */
export async function getLoginShellEnv(): Promise<Record<string, string>> {
  if (cachedShellEnv !== null) return cachedShellEnv
  if (envInFlight) return envInFlight

  envInFlight = resolveLoginShellEnv(nodePorts)
    .then((value) => {
      cachedShellEnv = value
      return value
    })
    .finally(() => {
      envInFlight = null
    })
  return envInFlight
}

async function resolveLoginShellEnv(ports: ShellEnvironmentPorts): Promise<Record<string, string>> {
  const shell = ports.shell()
  for (const args of [
    ['-lic', 'env -0'],
    ['-lc', 'env -0'],
  ]) {
    try {
      const stdout = await ports.run(shell, args, {
        timeoutMs: 15_000,
        // Credentials are small, but rc-file chatter is unbounded.
        maxBytes: 4 * 1024 * 1024,
      })
      const parsed = parseNulEnv(stdout, ports.accepts)
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
function parseNulEnv(stdout: string, accepts: (name: string) => boolean): Record<string, string> {
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
    if (!accepts(name)) continue
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
  if (shellPath) {
    // Prefer the shell's PATH, keeping any inherited entries as a fallback.
    const inherited = process.env.PATH ?? ''
    const merged = inherited ? `${shellPath}:${inherited}` : shellPath
    base.PATH = dedupePath(merged)
  }
  return { ...base, ...extra }
}

function dedupePath(path: string): string {
  const seen = new Set<string>()
  return path
    .split(':')
    .filter((entry) => entry && !seen.has(entry) && (seen.add(entry), true))
    .join(':')
}

/** Test seam: forget the cached PATH and shell env. */
export function resetShellPathCache(): void {
  cachedPath = null
  inFlight = null
  cachedShellEnv = null
  envInFlight = null
}
