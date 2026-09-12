import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ClaudeAuthStatus,
  ClaudeStatus,
  PiPackageEntry,
  PiPackageResources,
} from '@shared/models'
import { piAgentDir } from './pi-paths'
import { claudeOneShotEnv } from './provider-detect'
import { getLoginShellPath, piProcessEnv } from './shell-env'
import { cachedPiHealth } from './health'
import { pickWhereMatch, resolveWindowsLaunch } from './win-launch'
import { readJsonFile } from './json-config'

const execFileAsync = promisify(execFile)

/**
 * Reading the `packages` arrays of pi's settings files and resolving each
 * entry to its install directory on disk.
 *
 * Mutations go through pi's own CLI (`pi install` / `pi remove` /
 * `pi update`), spawned by the job runner below — pi owns pinning, git-ref
 * reconciliation and `npmCommand` wrappers, so Phosphor never re-implements
 * install semantics. This module only *displays* state.
 */

/** A settings `packages` entry: plain spec or the filtered object form. */
type RawPackageEntry = string | { source: string; [key: string]: unknown }

interface ScopeDirs {
  /** Directory holding settings.json — relative path specs resolve here. */
  settingsDir: string
  scope: 'global' | 'project'
}

export function classifySpec(spec: string): 'npm' | 'git' | 'path' {
  if (spec.startsWith('npm:')) return 'npm'
  if (spec.startsWith('git:')) return 'git'
  if (/^(https?|ssh|git):\/\//.test(spec)) return 'git'
  return 'path'
}

/** `npm:@scope/name@1.2.3` → `@scope/name` (version suffix stripped). */
export function npmNameFromSpec(spec: string): string {
  const withoutPrefix = spec.slice('npm:'.length)
  const at = withoutPrefix.lastIndexOf('@')
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix
}

/**
 * Best-effort `<host>/<path>` for a git spec, mirroring pi's clone layout
 * (`<base>/git/<host>/<path>`). Handles `git:host/path`, `git@host:path`,
 * and protocol URLs; strips `.git` and `@ref` suffixes.
 */
export function gitDirFromSpec(spec: string): string | null {
  let rest = spec.startsWith('git:') ? spec.slice(4) : spec
  const protocol = /^(https?|ssh|git):\/\//.exec(rest)
  if (protocol) rest = rest.slice(protocol[0].length)
  // git@github.com:user/repo → github.com/user/repo
  const scpLike = /^[\w.-]+@([\w.-]+):(.+)$/.exec(rest)
  if (scpLike) rest = `${scpLike[1]}/${scpLike[2]}`
  // ssh://git@github.com/user/repo → github.com/user/repo
  else rest = rest.replace(/^[\w.-]+@/, '')
  // Strip a pinned ref, then .git
  const at = rest.lastIndexOf('@')
  if (at > rest.indexOf('/')) rest = rest.slice(0, at)
  if (rest.endsWith('.git')) rest = rest.slice(0, -4)
  return rest.includes('/') ? rest : null
}

export function resolveInstallPath(
  spec: string,
  kind: 'npm' | 'git' | 'path',
  dirs: ScopeDirs,
): string | null {
  // Global packages install beside `~/.pi/agent`; project packages under
  // `<ws>/.pi` — both are exactly the settings file's directory.
  const base = dirs.settingsDir
  if (kind === 'npm') return join(base, 'npm', 'node_modules', npmNameFromSpec(spec))
  if (kind === 'git') {
    const dir = gitDirFromSpec(spec)
    return dir ? join(base, 'git', dir) : null
  }
  return isAbsolute(spec) ? spec : resolve(base, spec)
}

async function readPackagesArray(settingsPath: string): Promise<RawPackageEntry[]> {
  // A missing or malformed file both read as empty here: malformed settings
  // are surfaced by pi:checkAgentSettings, so this module simply has nothing
  // to list.
  const { value } = await readJsonFile<{ packages?: unknown }>(settingsPath)
  if (!Array.isArray(value.packages)) return []
  return value.packages.filter(
    (entry): entry is RawPackageEntry =>
      typeof entry === 'string' ||
      (typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { source?: unknown }).source === 'string'),
  )
}

const EMPTY_RESOURCES: PiPackageResources = {
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Resources a package directory provides: the `pi` manifest arrays when
 * declared (shown as written, exclusions dropped), else pi's convention
 * directories.
 */
function discoverResources(installPath: string): PiPackageResources {
  let stats
  try {
    stats = statSync(installPath)
  } catch {
    return EMPTY_RESOURCES
  }
  // A single-file package is one extension.
  if (stats.isFile()) {
    return { ...EMPTY_RESOURCES, extensions: [basename(installPath)] }
  }

  const manifest = readPackageJson(installPath)?.pi
  if (manifest && typeof manifest === 'object') {
    const fromManifest = (key: string): string[] => {
      const value = (manifest as Record<string, unknown>)[key]
      if (!Array.isArray(value)) return []
      return value.filter((v): v is string => typeof v === 'string' && !v.startsWith('!'))
    }
    return {
      extensions: fromManifest('extensions'),
      skills: fromManifest('skills'),
      prompts: fromManifest('prompts'),
      themes: fromManifest('themes'),
    }
  }

  const byExt = (dir: string, exts: string[]): string[] =>
    listDir(join(installPath, dir)).filter((f) => exts.some((ext) => f.endsWith(ext)))
  const skills = listDir(join(installPath, 'skills')).filter(
    (entry) => entry.endsWith('.md') || existsSync(join(installPath, 'skills', entry, 'SKILL.md')),
  )
  return {
    extensions: byExt('extensions', ['.ts', '.js']),
    skills,
    prompts: byExt('prompts', ['.md']),
    themes: byExt('themes', ['.json']),
  }
}

interface PackageJsonBits {
  name?: string
  version?: string
  description?: string
  pi?: unknown
}

function readPackageJson(dir: string): PackageJsonBits | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJsonBits
  } catch {
    return null
  }
}

function toEntry(raw: RawPackageEntry, dirs: ScopeDirs): PiPackageEntry {
  const spec = typeof raw === 'string' ? raw : raw.source
  const filtered = typeof raw !== 'string'
  const kind = classifySpec(spec)
  const installPath = resolveInstallPath(spec, kind, dirs)
  const installed = installPath !== null && existsSync(installPath)

  const pkg = installed && installPath ? readPackageJson(installPath) : null
  const fallbackName =
    kind === 'npm'
      ? npmNameFromSpec(spec)
      : kind === 'git'
        ? (gitDirFromSpec(spec) ?? spec)
        : basename(spec)

  return {
    spec,
    scope: dirs.scope,
    kind,
    filtered,
    name: pkg?.name ?? fallbackName,
    version: pkg?.version,
    description: pkg?.description,
    installed,
    installPath: installPath ?? undefined,
    resources: installed && installPath ? discoverResources(installPath) : EMPTY_RESOURCES,
  }
}

/** All packages declared in the global and (when given) project settings. */
export async function listPackages(workspacePath?: string): Promise<PiPackageEntry[]> {
  const scopes: ScopeDirs[] = [{ settingsDir: piAgentDir(), scope: 'global' }]
  if (workspacePath) scopes.push({ settingsDir: join(workspacePath, '.pi'), scope: 'project' })

  const perScope = await Promise.all(
    scopes.map(async (dirs) => {
      const raws = await readPackagesArray(join(dirs.settingsDir, 'settings.json'))
      return raws.map((raw) => toEntry(raw, dirs))
    }),
  )
  return perScope.flat()
}

// ---------- job runner ----------

/** Sender surface the runner needs (subset of Electron.WebContents). */
export interface JobSender {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

const activeJobs = new Map<string, ReturnType<typeof spawn>>()

/**
 * Spawn a command and stream its output to the renderer on
 * `packages:output:<jobId>` / `packages:exit:<jobId>`. Output and exit are
 * fire-and-forget: a closed window simply stops receiving.
 */
export function startJob(
  sender: JobSender,
  command: string,
  args: string[],
  options: { cwd?: string; env: Record<string, string> },
): { jobId: string } {
  const jobId = randomUUID()
  const outputChannel = `packages:output:${jobId}`
  const exitChannel = `packages:exit:${jobId}`
  const emit = (channel: string, payload: unknown): void => {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeJobs.set(jobId, child)

  child.stdout?.on('data', (chunk: Buffer) => emit(outputChannel, chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => emit(outputChannel, chunk.toString()))
  child.on('error', (error) => {
    emit(outputChannel, `${error.message}\n`)
    emit(exitChannel, 127)
    activeJobs.delete(jobId)
  })
  child.on('close', (code) => {
    emit(exitChannel, code ?? 1)
    activeJobs.delete(jobId)
  })

  return { jobId }
}

/** Resolve a binary on the login-shell PATH (GUI launches lack it). */
export async function resolveBinary(name: string): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', [name], { timeout: 15_000 })
      // Not the first line: for an npm-installed CLI that is the POSIX sh
      // shim, which nothing on Windows can run. A `.exe` is spawnable; a
      // `.cmd` is returned as found and fails at spawn (EINVAL) — pi itself
      // never comes through here (see resolvePiInvoker), and the callers that
      // do (claude, npm, uv, pipx, headroom) mostly ship real executables.
      return pickWhereMatch(stdout)
    } catch {
      return null
    }
  }
  const shellPath = await getLoginShellPath()
  for (const env of [shellPath ? { ...process.env, PATH: shellPath } : null, { ...process.env }]) {
    if (!env) continue
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `command -v ${name}`], {
        timeout: 15_000,
        env,
      })
      const found = stdout.trim().split('\n').pop()?.trim()
      if (found) return found
    } catch {
      // try the next env
    }
  }
  return null
}

/** Report a spawn-precondition failure through the job channels. */
export function failedJob(sender: JobSender, message: string): { jobId: string } {
  const jobId = randomUUID()
  // Delay so the renderer can subscribe with the returned jobId first.
  setTimeout(() => {
    if (sender.isDestroyed()) return
    sender.send(`packages:output:${jobId}`, `${message}\n`)
    sender.send(`packages:exit:${jobId}`, 127)
  }, 0)
  return { jobId }
}

/**
 * How to invoke pi for package jobs. The e2e stub is a Node script, so it
 * runs through Electron-as-Node exactly like the session spawner does
 * (pi-session-handlers computes and passes the override; this module stays
 * Electron-free for unit tests).
 */
export interface PiInvoker {
  command: string
  prefixArgs: string[]
  env: Record<string, string>
}

async function resolvePiInvoker(stubPath?: string): Promise<PiInvoker | null> {
  if (stubPath) {
    return {
      command: process.execPath,
      prefixArgs: [stubPath],
      env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  // Through the health probe, not `resolveBinary('pi')`: on Windows the thing
  // to spawn is node.exe plus pi's entry script (PiHealth.prefixArgs).
  const health = await cachedPiHealth()
  if (!health.ok || !health.binaryPath) return null
  return {
    command: health.binaryPath,
    prefixArgs: health.prefixArgs ?? [],
    env: await piProcessEnv(),
  }
}

/** `pi install|remove|update` through pi's own package manager. */
export async function runPackageAction(
  sender: JobSender,
  action: 'install' | 'remove' | 'update',
  spec: string | undefined,
  scope: 'global' | 'project',
  workspacePath?: string,
  stubPath?: string,
): Promise<{ jobId: string }> {
  const invoker = await resolvePiInvoker(stubPath)
  if (!invoker) return failedJob(sender, 'pi binary not found on PATH')
  if (scope === 'project' && !workspacePath) {
    return failedJob(sender, 'project scope requires a workspace')
  }

  const args: string[] = [...invoker.prefixArgs, action]
  if (action === 'update' && !spec) args.push('--extensions')
  if (spec) args.push(spec)
  if (scope === 'project') args.push('-l')

  return startJob(sender, invoker.command, args, {
    cwd: scope === 'project' ? workspacePath : undefined,
    env: invoker.env,
  })
}

/** One-click pi install/update via the user's own npm. */
export async function runPiInstall(sender: JobSender): Promise<{ jobId: string }> {
  const npm = await resolveLaunch('npm')
  if (!npm) {
    return failedJob(
      sender,
      'npm was not found on your PATH. Install Node.js 22+ first (https://nodejs.org), then retry.',
    )
  }
  return startJob(
    sender,
    npm.file,
    [...npm.prefixArgs, 'install', '-g', '@earendil-works/pi-coding-agent'],
    { env: await piProcessEnv() },
  )
}

/**
 * A binary as something `spawn` accepts. Same as `resolveBinary` everywhere
 * but Windows, where an npm CLI (`npm.cmd` itself included) is a shim that
 * has to be run as node.exe plus its entry script — see win-launch.ts.
 */
async function resolveLaunch(name: string): Promise<{ file: string; prefixArgs: string[] } | null> {
  if (process.platform !== 'win32') {
    const file = await resolveBinary(name)
    return file ? { file, prefixArgs: [] } : null
  }
  const where = async (bin: string): Promise<string> => {
    const { stdout } = await execFileAsync('where', [bin], { timeout: 15_000 })
    return stdout
  }
  const result = await resolveWindowsLaunch(await where(name).catch(() => ''), {
    readShim: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    whereNode: () => where('node'),
  })
  return result.ok ? result.launch : null
}

/** Binary presence for catalogue recommendations. */
export async function detectBinaries(claudeOverride?: string): Promise<{ claude: boolean }> {
  const path = claudeOverride ?? (await resolveBinary('claude'))
  return { claude: path !== null }
}

// ---------- update checks ----------

/**
 * Latest published version for each npm-sourced package, from the registry.
 *
 * pi installs a package once and never moves it again on its own, so a
 * fix published upstream is invisible until someone runs `pi update`. This
 * is what lets the UI say "0.4.3 → 0.4.4" instead of the user discovering
 * months later that they are running old code.
 *
 * Best-effort by design: offline, a private registry, or an unpublished
 * package all yield `null` rather than an error, because a failed version
 * check must never make package management look broken.
 */
export async function checkPackageUpdates(
  entries: PiPackageEntry[],
): Promise<Record<string, string | null>> {
  const npmEntries = entries.filter((entry) => entry.kind === 'npm')
  const results = await Promise.all(
    npmEntries.map(
      async (entry) => [entry.spec, await latestNpmVersion(npmNameFromSpec(entry.spec))] as const,
    ),
  )
  return Object.fromEntries(results)
}

/** `latest` dist-tag from the npm registry, or null on any failure. */
async function latestNpmVersion(name: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** npm package name of the Claude Code CLI, whatever way it was installed. */
export const CLAUDE_CLI_PACKAGE = '@anthropic-ai/claude-code'

/**
 * Latest published Claude Code CLI version.
 *
 * The CLI is not a pi package, so `checkPackageUpdates` never sees it and it
 * can sit months behind while every other row in the provider tab reads
 * green. Both install kinds share one release train — the native installer
 * (`~/.local/share/claude/versions/<v>`) and the npm package publish the same
 * numbers — so the registry answers for either.
 */
export async function checkClaudeCliUpdate(): Promise<string | null> {
  return latestNpmVersion(CLAUDE_CLI_PACKAGE)
}

/**
 * `claude update` as a streamed job.
 *
 * Deliberately the CLI's own subcommand rather than `npm install -g`: on this
 * machine, and on any 2.x install done by the official script, `claude` is a
 * native build under `~/.local/share/claude/versions/` with a symlink in
 * `~/.local/bin` — npm does not own it and `npm install -g` would leave the
 * symlink pointing at the old build. `claude update` handles both layouts and
 * prints what it did, which is why the output is streamed verbatim.
 */
export async function runClaudeUpdate(
  sender: JobSender,
  claudeOverride?: string,
): Promise<{ jobId: string }> {
  const path = claudeOverride ?? (await resolveBinary('claude'))
  if (!path) return failedJob(sender, 'claude was not found on your login-shell PATH')
  return startJob(sender, path, ['update'], { env: await piProcessEnv() })
}

// ---------- Claude Code provider support (per-extension tab) ----------

/**
 * Parse `claude auth status` output (JSON on Claude Code 2.x). Tolerates
 * leading noise before the JSON object and non-JSON output from older CLIs.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  const start = stdout.indexOf('{')
  if (start === -1) return { ok: false, error: stdout.trim().slice(0, 200) || 'no output' }
  try {
    const parsed = JSON.parse(stdout.slice(start)) as {
      loggedIn?: unknown
      authMethod?: unknown
      email?: unknown
      subscriptionType?: unknown
      orgName?: unknown
      orgId?: unknown
    }
    return {
      ok: true,
      loggedIn: parsed.loggedIn === true,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      plan: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
      organization: typeof parsed.orgName === 'string' ? parsed.orgName : undefined,
      method: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
    }
  } catch {
    return { ok: false, error: 'unparseable auth status output' }
  }
}

/** Extract a version like "2.1.219" from mixed CLI output. */
function versionFrom(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(output)?.[1]
}

/**
 * Claude Code CLI health for the provider tab: binary presence + version and
 * local auth state. `claude auth status` reads local credentials only (no
 * network round-trip), so probing on tab mount is fine.
 */
export async function claudeStatus(
  claudeOverride?: string,
  /** Credential-scoping env for one account; see electron/claude/accounts.ts. */
  extraEnv?: Record<string, string>,
): Promise<ClaudeStatus> {
  const path = claudeOverride ?? (await resolveBinary('claude'))
  if (!path) return { binary: { found: false }, auth: { ok: false, error: 'claude not found' } }

  const env = { ...(await piProcessEnv()), ...extraEnv }
  let version: string | undefined
  try {
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000, env })
    version = versionFrom(stdout)
  } catch {
    // Version is cosmetic; auth state below is the load-bearing part.
  }

  try {
    const { stdout } = await execFileAsync(path, ['auth', 'status'], { timeout: 10_000, env })
    return { binary: { found: true, path, version }, auth: parseClaudeAuthStatus(stdout) }
  } catch (error) {
    const failure = error as { stdout?: string; message: string }
    // Non-zero exit still prints the status JSON when logged out.
    const auth = failure.stdout
      ? parseClaudeAuthStatus(failure.stdout)
      : { ok: false, error: failure.message }
    return { binary: { found: true, path, version }, auth }
  }
}

/**
 * One-click provider proof: a single print-mode turn through the
 * pi-claude-cli provider, streamed like any package job. Runs from the OS
 * temp dir so no workspace is touched; spends one tiny prompt of plan usage.
 */
export async function runClaudeProviderTest(
  sender: JobSender,
  stubPath?: string,
): Promise<{ jobId: string }> {
  const invoker = await resolvePiInvoker(stubPath)
  if (!invoker) return failedJob(sender, 'pi binary not found on PATH')
  return startJob(
    sender,
    invoker.command,
    [
      ...invoker.prefixArgs,
      '-p',
      '--model',
      'pi-claude-cli/claude-haiku-4-5',
      'Reply with exactly: phosphor-provider-ok',
    ],
    // `claudeOneShotEnv` or the job never ends: 0.7.0 parks the CLI process
    // after `result`, and startJob has no timeout — the test would print
    // "phosphor-provider-ok" and then sit as a running job for ten minutes.
    { cwd: tmpdir(), env: { ...invoker.env, ...claudeOneShotEnv() } },
  )
}
