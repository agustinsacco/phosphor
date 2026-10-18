import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ClaudeAuthStatus, ClaudeStatus, PiPackageEntry } from '@shared/models'
import { listPackages, npmNameFromSpec } from '@phosphor/session-runtime/pi/packages'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { claudeOneShotEnv, claudeProviderSpawnEnv } from './provider-detect'
import { piProcessEnv } from './shell-env'
import { cachedPiHealth } from './health'
import { lookupPosixBinary, windowsWhereOutput } from './binary-lookup'
import { pickWhereMatch, resolveWindowsLaunch } from './win-launch'
import { killProcessTree, OWN_GROUP, runPrintMode } from './print-mode'

const execFileAsync = promisify(execFile)

/**
 * pi package jobs and binaries. What settings declare, and where each
 * package is installed, is read by `@phosphor/session-runtime/pi/packages`.
 *
 * Mutations go through pi's own CLI (`pi install` / `pi remove` /
 * `pi update`), spawned by the job runner below — pi owns pinning, git-ref
 * reconciliation and `npmCommand` wrappers, so Phosphor never re-implements
 * install semantics.
 */

/**
 * Skill bundle directories of every installed package, for the Skills page's
 * scan fallback: without them, a pi that could not be asked made every
 * package skill vanish from the list.
 */
export async function packageSkillDirs(
  workspacePath?: string,
): Promise<Array<{ dir: string; scope: 'user' | 'project'; source: string }>> {
  const found: Array<{ dir: string; scope: 'user' | 'project'; source: string }> = []
  for (const entry of await listPackages(workspacePath)) {
    if (!entry.installed || !entry.installPath) continue
    for (const path of resolvePackagePaths(entry.installPath).skills) {
      if (path.endsWith('.md')) continue
      found.push({
        dir: path,
        scope: entry.scope === 'project' ? 'project' : 'user',
        source: entry.spec,
      })
    }
  }
  return found
}

// ---------- job runner ----------

/** Sender surface the runner needs (subset of Electron.WebContents). */
export interface JobSender {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** Generous: a slow install takes minutes. A job still running is hung. */
const PACKAGE_JOB_TIMEOUT_MS = 15 * 60_000
/** One tiny print-mode turn: the bound a session title run gets. */
const PROVIDER_PROOF_TIMEOUT_MS = 30_000
/** How long quit waits for stopped jobs to report before going on. */
const DISPOSE_SETTLE_MS = 3_000
/** What a stopped job reports: a killed child always reported `code ?? 1`. */
const STOPPED_EXIT_CODE = 1
const SHUTTING_DOWN = 'Phosphor is shutting down. New work cannot start.'

/** A running job as disposal sees it: stop it, then wait for its exit. */
const activeJobs = new Map<string, { cancel: (reason: string) => void; settled: Promise<void> }>()
/** Set by disposePackageJobs; from then on every new job is refused. */
let disposal: Promise<void> | null = null

/**
 * Register a job. `output` streams on `packages:output:<jobId>`; `finish`
 * runs `onExit`, then reports on `packages:exit:<jobId>` — once, whichever of
 * exit, error, deadline and `cancel` comes first. Nothing streams after it,
 * and a closed window simply stops receiving.
 */
function trackJob(
  sender: JobSender,
  stop: (reason: string) => void,
  onExit?: (code: number) => void,
): {
  jobId: string
  output: (text: string) => void
  finish: (code: number) => void
  cancel: (reason: string) => void
} {
  const jobId = randomUUID()
  const emit = (channel: string, payload: unknown): void => {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  }
  let finished = false
  let settle = (): void => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const cancel = (reason: string): void => {
    if (!finished) stop(reason)
  }
  activeJobs.set(jobId, { cancel, settled })
  return {
    jobId,
    cancel,
    output: (text) => {
      if (!finished) emit(`packages:output:${jobId}`, text)
    },
    finish: (code) => {
      if (finished) return
      finished = true
      activeJobs.delete(jobId)
      try {
        onExit?.(code)
      } finally {
        emit(`packages:exit:${jobId}`, code)
        settle()
      }
    },
  }
}

/**
 * Spawn a command and stream its output to the renderer on
 * `packages:output:<jobId>` / `packages:exit:<jobId>`. The job leads its own
 * process tree, so its deadline and quit stop whatever it started too.
 */
export function startJob(
  sender: JobSender,
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: Record<string, string>
    /**
     * Runs in main when the job ends, before the renderer hears the exit —
     * so a cache the job made stale is already dropped by the time the UI
     * re-asks. Fires once, for a spawn failure (code 127) and a stop too.
     */
    onExit?: (code: number) => void
  },
): { jobId: string } {
  if (disposal) return failedJob(sender, SHUTTING_DOWN)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: OWN_GROUP,
  })
  const job = trackJob(
    sender,
    (reason) => {
      job.output(`${reason}\n`)
      killProcessTree(child)
      finish(STOPPED_EXIT_CODE)
    },
    options.onExit,
  )
  const deadline = setTimeout(
    () => job.cancel('Stopped: still running after 15 minutes.'),
    PACKAGE_JOB_TIMEOUT_MS,
  )
  const finish = (code: number): void => {
    clearTimeout(deadline)
    job.finish(code)
  }

  child.stdout?.on('data', (chunk: Buffer) => job.output(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => job.output(chunk.toString()))
  child.on('error', (error) => {
    job.output(`${error.message}\n`)
    finish(127)
  })
  child.on('close', (code) => finish(code ?? 1))

  return { jobId: job.jobId }
}

/**
 * A print-mode run as a streamed job: stdout streams, a failure ends with
 * print mode's reason, and the exit is 0 for a clean answer, else 1. Starts
 * a tick late, like failedJob, because a spawn failure settles at once.
 */
function startPrintModeJob(
  sender: JobSender,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): { jobId: string } {
  if (disposal) return failedJob(sender, SHUTTING_DOWN)
  const controller = new AbortController()
  const job = trackJob(sender, (reason) => {
    job.output(`${reason}\n`)
    controller.abort()
  })
  setTimeout(() => {
    void runPrintMode(command, args, {
      ...options,
      signal: controller.signal,
      onStdout: job.output,
    }).then(({ error }) => {
      if (error) job.output(`${error}\n`)
      job.finish(error ? 1 : 0)
    })
  }, 0)
  return { jobId: job.jobId }
}

/**
 * Stop every package job and refuse new ones; approved quit calls this so no
 * job's process tree outlives Phosphor. Idempotent. Resolves once every
 * stopped job has reported, or after DISPOSE_SETTLE_MS.
 */
export function disposePackageJobs(): Promise<void> {
  if (disposal) return disposal
  const stopping = [...activeJobs.values()]
  disposal = new Promise<void>((resolve) => {
    const bound = setTimeout(resolve, DISPOSE_SETTLE_MS)
    void Promise.all(stopping.map((job) => job.settled)).then(() => {
      clearTimeout(bound)
      resolve()
    })
  })
  for (const job of stopping) {
    try {
      job.cancel('Stopped: Phosphor is quitting.')
    } catch (error) {
      // A throwing onExit must not leave the other jobs running. It still
      // surfaces, as it would from a job's own exit.
      queueMicrotask(() => {
        throw error
      })
    }
  }
  return disposal
}

/** Resolve a binary on the login-shell PATH (GUI launches lack it). */
export async function resolveBinary(name: string): Promise<string | null> {
  // Not the first `where` line on Windows: for an npm-installed CLI that is
  // the POSIX sh shim, which nothing on Windows can run. A `.exe` is
  // spawnable; a `.cmd` is returned as found and fails at spawn (EINVAL) — pi
  // itself never comes through here (see resolvePiInvoker), and the callers
  // that do (claude, npm, uv, pipx, headroom) mostly ship real executables.
  if (process.platform === 'win32') return pickWhereMatch(await windowsWhereOutput(name))
  return lookupPosixBinary(name)
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
  /** See `startJob`'s `onExit`. */
  onExit?: (code: number) => void,
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
    ...(onExit ? { onExit } : {}),
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
  const result = await resolveWindowsLaunch(await windowsWhereOutput(name), {
    readShim: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    whereNode: () => windowsWhereOutput('node'),
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
 * Through runPrintMode, never a plain job: `pi -p` needs stdin ignored, and
 * print mode bounds the run and kills its tree.
 */
export async function runClaudeProviderTest(
  sender: JobSender,
  stubPath?: string,
): Promise<{ jobId: string }> {
  const invoker = await resolvePiInvoker(stubPath)
  if (!invoker) return failedJob(sender, 'pi binary not found on PATH')
  return startPrintModeJob(
    sender,
    invoker.command,
    [
      ...invoker.prefixArgs,
      '-p',
      '--model',
      'pi-claude-cli/claude-haiku-4-5',
      'Reply with exactly: phosphor-provider-ok',
    ],
    // Under the context policy every session gets, so the proof is of the
    // provider as sessions run it. And `claudeOneShotEnv`, or 0.7.0 parks the
    // CLI process after `result`: the proof would print "phosphor-provider-ok"
    // and then fail at the timeout instead of exiting.
    {
      cwd: tmpdir(),
      env: { ...invoker.env, ...claudeProviderSpawnEnv(), ...claudeOneShotEnv() },
      timeoutMs: PROVIDER_PROOF_TIMEOUT_MS,
    },
  )
}
