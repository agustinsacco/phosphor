import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { PiPackageEntry } from '@shared/models'
import { listPackages, npmNameFromSpec } from '@phosphor/session-runtime/pi/packages'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { claudeOneShotEnv, claudeProviderSpawnEnv } from './provider-detect'
import { piProcessEnv } from './shell-env'
import { PiUnavailableError, resolvePiInvoker } from './invoker'
import { resolveBinary, windowsWhereOutput } from './binary-lookup'
import { resolveWindowsLaunch } from './win-launch'
import { failedJob, startJob, startPrintModeJob, type JobSender } from './package-jobs'

export { failedJob, startJob, disposePackageJobs, type JobSender } from './package-jobs'
export { claudeStatus, parseClaudeAuthStatus } from './claude-status'
export { resolveBinary } from './binary-lookup'

/** One tiny print-mode turn: the bound a session title run gets. */
const PROVIDER_PROOF_TIMEOUT_MS = 30_000

/**
 * pi package jobs and binaries. What settings declare, and where each
 * package is installed, is read by `@phosphor/session-runtime/pi/packages`.
 *
 * Mutations go through pi's own CLI (`pi install` / `pi remove` /
 * `pi update`), spawned by the package job runner — pi owns pinning, git-ref
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
  const invoker = await resolvePiInvoker('inherited-stub', { stubPath }).catch((error: unknown) => {
    if (error instanceof PiUnavailableError) return null
    throw error
  })
  if (!invoker) return failedJob(sender, 'pi binary not found on PATH')
  if (scope === 'project' && !workspacePath) {
    return failedJob(sender, 'project scope requires a workspace')
  }

  const args: string[] = [...invoker.prefixArgs, action]
  if (action === 'update' && !spec) args.push('--extensions')
  if (spec) args.push(spec)
  if (scope === 'project') args.push('-l')

  return startJob(sender, invoker.binaryPath, args, {
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
  const invoker = await resolvePiInvoker('inherited-stub', { stubPath }).catch((error: unknown) => {
    if (error instanceof PiUnavailableError) return null
    throw error
  })
  if (!invoker) return failedJob(sender, 'pi binary not found on PATH')
  return startPrintModeJob(
    sender,
    invoker.binaryPath,
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
