import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * How Phosphor runs an npm-installed CLI on Windows.
 *
 * `npm install -g` on Windows does not produce an executable. It writes three
 * shims next to each other — `pi` (a POSIX sh script), `pi.cmd` and `pi.ps1` —
 * and the `.cmd` one is what a terminal actually runs. Two things make that
 * shim unusable as a spawn target:
 *
 *  1. Node refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL,
 *     since the CVE-2024-27980 fix in 18.20 / 20.12 / 22). Every Node that
 *     Electron 43 could embed has the check.
 *  2. `shell: true` would route the whole command line through `cmd.exe`,
 *     whose quoting rules Node does not implement for arguments. pi's argv
 *     carries the model's system prompt (`--append-system-prompt`) — arbitrary
 *     text with quotes, percent signs and newlines — so that path is not
 *     merely fragile, it is an injection surface.
 *
 * What the shim itself does is simple: run `node` on a JS entry point. This
 * module reads the shim and does the same thing directly, so pi is spawned as
 * `node.exe <cli.js> --mode rpc …`, an ordinary `spawn` with an argv array.
 * `PiSpawnOptions.prefixArgs` exists for exactly this.
 *
 * Everything here is pure string work over the shim's text, so it is unit
 * tested on every platform; only `resolveWindowsLaunch` touches the disk.
 */

/** A spawnable command: `file` plus the arguments that precede the CLI's own. */
export interface WindowsLaunch {
  file: string
  prefixArgs: string[]
}

/**
 * Pick the usable match out of `where <name>`.
 *
 * `where` lists every PATH hit, in PATH order, and for an npm-installed CLI
 * that is `pi`, `pi.cmd` and `pi.ps1` from the same directory, sh script
 * first. Only two of those shapes can be run: a real executable, and a
 * `.cmd`/`.bat` shim that this module can read through. An extensionless hit
 * is a POSIX script and is skipped — except as a hint that `<hit>.cmd` may sit
 * beside it, which `where` can omit when PATHEXT is unusual.
 */
export function pickWhereMatch(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const executable = lines.find((line) => /\.exe$/i.test(line))
  if (executable) return executable
  const shim = lines.find((line) => /\.(cmd|bat)$/i.test(line))
  if (shim) return shim
  const bare = lines.find((line) => !/\.[a-z0-9]+$/i.test(line))
  return bare ? `${bare}.cmd` : null
}

/**
 * The JS entry an npm cmd-shim runs, as an absolute path.
 *
 * Both shim generations npm has shipped name the script relative to the
 * shim's own directory:
 *
 *   npm ≥ 7 (cmd-shim 4+):   "%_prog%"  "%dp0%\node_modules\<pkg>\dist\cli.js" %*
 *   npm ≤ 6:                 "%~dp0\node.exe"  "%~dp0\node_modules\<pkg>\bin\cli.js" %*
 *
 * pnpm's fork of cmd-shim keeps the `%dp0%` form. Anything else — a Scoop
 * wrapper pointing at another `.cmd`, a hand-written batch file — returns
 * null, and the caller reports that pi was found but cannot be run, rather
 * than guessing.
 */
export function parseNpmCmdShim(shimText: string, shimDir: string): string | null {
  const match = /"%(?:~)?dp0%?\\([^"\r\n]+?\.(?:c|m)?js)"/i.exec(shimText)
  if (!match) return null
  const relative = match[1]!.replace(/^[\\/]+/, '')
  // Windows path arithmetic regardless of host, so the pure functions test the
  // same on macOS/Linux CI as they behave on the machine they are for.
  return win32.normalize(win32.join(shimDir, relative))
}

/**
 * The `node.exe` the shim would have used: one beside the shim first (fnm
 * and nvm-windows lay `node.exe` and the global bins in the same directory),
 * then whatever `where node` found. Mirrors the shim's own
 * `IF EXIST "%dp0%\node.exe"` branch.
 */
export function pickNodeExecutable(shimDir: string, whereNodeStdout: string): string | null {
  const beside = win32.join(shimDir, 'node.exe')
  if (existsSync(beside)) return beside
  const found = pickWhereMatch(whereNodeStdout)
  return found && /\.exe$/i.test(found) ? found : null
}

export type WindowsLaunchFailure =
  | { kind: 'not-found' }
  | { kind: 'unreadable-shim'; shimPath: string }
  | { kind: 'no-node'; shimPath: string }

/**
 * Turn a `where` hit into something `spawn` accepts.
 *
 * A `.exe` (volta's shims, a native build) is spawnable as is. A `.cmd`/`.bat`
 * is read for its entry script and run through `node.exe`. `readShim` and
 * `whereNode` are injected so the resolution is testable without a Windows
 * PATH; production wires them to `readFileSync` and `where node`.
 */
export async function resolveWindowsLaunch(
  whereStdout: string,
  deps: {
    readShim: (path: string) => string | null
    whereNode: () => Promise<string>
    exists?: (path: string) => boolean
  },
): Promise<{ ok: true; launch: WindowsLaunch } | { ok: false; failure: WindowsLaunchFailure }> {
  const exists = deps.exists ?? existsSync
  const hit = pickWhereMatch(whereStdout)
  if (!hit || !win32.isAbsolute(hit) || !exists(hit))
    return { ok: false, failure: { kind: 'not-found' } }
  if (/\.exe$/i.test(hit)) return { ok: true, launch: { file: hit, prefixArgs: [] } }

  const shimDir = win32.dirname(hit)
  const text = deps.readShim(hit)
  const entry = text ? parseNpmCmdShim(text, shimDir) : null
  if (!entry || !exists(entry)) {
    return { ok: false, failure: { kind: 'unreadable-shim', shimPath: hit } }
  }
  const node = pickNodeExecutable(shimDir, await deps.whereNode().catch(() => ''))
  if (!node) return { ok: false, failure: { kind: 'no-node', shimPath: hit } }
  return { ok: true, launch: { file: node, prefixArgs: [entry] } }
}

/** One sentence for the setup screen, per failure. */
export function describeWindowsLaunchFailure(failure: WindowsLaunchFailure): string {
  switch (failure.kind) {
    case 'not-found':
      return (
        'The pi coding agent was not found on your PATH. Install it with: ' +
        'npm install -g @earendil-works/pi-coding-agent'
      )
    case 'unreadable-shim':
      return (
        `Found pi at ${failure.shimPath}, but it is not an npm command shim, so Phosphor ` +
        'cannot run it directly. Install pi with: npm install -g @earendil-works/pi-coding-agent'
      )
    case 'no-node':
      return (
        `Found pi at ${failure.shimPath}, but node.exe could not be located to run it. ` +
        'Make sure Node.js is on your PATH (a version manager that only sets it up per ' +
        'terminal is not visible to a desktop app).'
      )
  }
}
