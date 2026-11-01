import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { errorText } from '@phosphor/shared/errors'
import { EXIT, exitCodeFor, fail, type Check } from '../checks'
import { CONFIG_MAX_BYTES, loadHostConfig } from '../config/load'
import { validateHostConfig, type HostConfigV1 } from '../config/schema'
import { buildPiEnvironment } from '../machine/environment'
import { isNodeScript, resolvePi, versionOf, which } from '../machine/executables'
import { probe } from '../machine/probe'
import { inspectTailscale, setupTailscaleHint } from '../machine/tailscale'
import { checkRepositories, isInsideRoot } from '../machine/repositories'
import { redactStrings, type DoctorContext } from './doctor'

export interface SetupContext extends DoctorContext {
  cwd: string
  repositories?: string[]
  pi?: string
  node?: string
  replace?: boolean
  /** Config-only SSH compatibility must not invoke Tailscale. */
  tailscaleHints?: boolean
}

export interface SetupReport {
  exitCode: number
  changed?: boolean
  config: string
  pi?: HostConfigV1['pi'] & { version?: string }
  nodeVersion?: string
  repositories?: string[]
  path?: string[]
  claude?: 'found' | 'not found'
  checks: Check[]
  notes: string[]
  next?: string
}

/** What even a replace keeps: the Host's identity, policy and its owner's own wiring. */
const KEPT_ON_REPLACE = [
  'hostId',
  'contextBudget',
  'agentDirectives',
  'accounts',
  'control',
  'api',
  'resourceRoot',
] as const satisfies readonly (keyof HostConfigV1)[]

function keptOnReplace(kept: HostConfigV1 | undefined): Partial<HostConfigV1> {
  return Object.fromEntries(
    KEPT_ON_REPLACE.flatMap((key) => (kept?.[key] !== undefined ? [[key, kept[key]]] : [])),
  ) as Partial<HostConfigV1>
}

/** Detect only local programs. No session, provider login or network request runs here. */
export async function runSetup(context: SetupContext): Promise<SetupReport> {
  const file = resolve(context.cwd, context.configPath)
  const report: SetupReport = { exitCode: EXIT.ok, config: file, checks: [], notes: [] }
  const stop = (code: number, message?: string) => {
    report.exitCode = code
    if (message) report.notes.push(message)
    return report
  }
  const exists = await lstat(file).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false
      throw error
    },
  )
  const old = exists ? await loadHostConfig(file, context.uid) : null
  if (old && !context.replace) {
    if (!old.ok) {
      report.notes.push(
        ...old.errors.map((error) => `${error.pointer || '(file)'}: ${error.message}`),
      )
      return stop(EXIT.config, 'the config is not usable; rerun with --replace to rewrite it')
    }
  }
  if (old && !old.ok) report.notes.push('the old config is not usable; replacing it')
  const kept = old?.ok ? old.config : undefined
  const discovery = buildPiEnvironment({ hostEnv: context.env, platform: context.platform })
  discovery.env.PATH = `${context.env.PATH ?? ''}:${discovery.env.PATH ?? ''}`
  const git = await which('git', discovery.env.PATH)
  let repositories = context.repositories?.length
    ? context.repositories.map((path) => resolve(context.cwd, path))
    : (kept?.repositories ?? [])
  // An existing config's folder list, even an empty one, is the user's choice: rerunning setup
  // inside a checkout must never add it. Only a first setup (or --replace) adopts the cwd.
  if (repositories.length === 0 && (!kept || context.replace)) {
    const top = git
      ? await probe(git, ['-C', context.cwd, 'rev-parse', '--show-toplevel'], {
          ...discovery,
          timeoutMs: context.probeTimeoutMs,
        })
      : null
    if (top && top.code === 0 && !top.truncated && top.stdout.trim().startsWith('/')) {
      repositories = [resolve(top.stdout.trim())]
    }
  }
  if (repositories.length === 0)
    report.notes.push(
      'Add a folder later with the Desktop folder picker or phosphor setup --repository PATH.',
    )
  const repositoryShape = validateHostConfig({
    version: 1,
    pi: { executable: '/unused' },
    repositories,
  })
  if (!repositoryShape.ok) {
    report.notes.push(
      ...repositoryShape.errors.map((error) => `${error.pointer}: ${error.message}`),
    )
    return stop(EXIT.usage)
  }
  const home = await realpath(context.home).catch(() => resolve(context.home))
  for (const path of repositories) {
    const real = await realpath(path).catch(() => null)
    if (!real || !(await stat(real)).isDirectory()) {
      return stop(EXIT.unavailable, `${path} is not an existing directory`)
    }
    if (real === '/' || isInsideRoot(home, real)) {
      return stop(EXIT.usage, `${path} is /, the home directory, or contains the home directory`)
    }
  }
  const keptPi =
    !context.replace && kept && (await stat(kept.pi.executable).catch(() => null))?.isFile()
      ? kept.pi.executable
      : undefined
  const executable = context.pi
    ? resolve(context.cwd, context.pi)
    : (keptPi ?? (await stable(await which('pi', discovery.env.PATH))))
  if (!executable) {
    return stop(
      EXIT.unavailable,
      'install pi first: npm install -g @earendil-works/pi-coding-agent',
    )
  }
  const realPi = await realpath(executable).catch(() => executable)
  const script = await isNodeScript(realPi)
  const node = script
    ? context.node
      ? resolve(context.cwd, context.node)
      : ((!context.replace ? kept?.pi.node : undefined) ??
        (await stable(
          // pi's `env node` shebang resolves through the user's PATH, never the platform defaults.
          (await which('node', dirname(executable))) ??
            (await which('node', context.env.PATH ?? '')),
        )))
    : null
  const pi = { executable, ...(node ? { node } : {}) }
  const path: string[] = [...(kept?.environment?.path ?? [])]
  const built =
    buildPiEnvironment({
      hostEnv: context.env,
      nodePath: pi.node,
      platform: context.platform,
    }).env.PATH?.split(':') ?? []
  const claude = await which('claude', discovery.env.PATH)
  for (const binary of [await stable(claude), await stable(git)]) {
    if (binary && !built.includes(dirname(binary)) && !path.includes(dirname(binary))) {
      path.push(dirname(binary))
    }
  }
  const config: HostConfigV1 = {
    ...(!context.replace ? kept : {}),
    version: 1,
    ...keptOnReplace(kept),
    pi,
    repositories: [...new Set(repositories)],
    environment: { ...(kept?.environment?.pass ? { pass: kept.environment.pass } : {}), path },
  }
  const validated = validateHostConfig(config)
  if (!validated.ok) {
    report.notes.push(...validated.errors.map((error) => `${error.pointer}: ${error.message}`))
    return stop(EXIT.config)
  }
  const environment = buildPiEnvironment({
    hostEnv: context.env,
    ...config.environment,
    nodePath: pi.node,
    platform: context.platform,
  })
  const resolved = await resolvePi(pi, environment, { timeoutMs: context.probeTimeoutMs })
  report.checks.push(...resolved.checks)
  if (!resolved.launch) return redactStrings(stop(exitCodeFor(report.checks)), environment.secrets)
  summarize(report, config)
  report.pi = { ...pi, version: resolved.launch.version }
  if (pi.node) {
    const version = await versionOf(
      pi.node,
      ['--version'],
      environment,
      context.probeTimeoutMs ?? 15_000,
    )
    if ('problem' in version) {
      report.checks.push(fail('pi-node', version.problem))
      return redactStrings(stop(EXIT.unavailable), environment.secrets)
    }
    report.nodeVersion = version.version
  }
  report.claude = claude ? 'found' : 'not found'
  if (!git) report.notes.push("git not found on the caller's PATH")
  const checked = await checkRepositories(config.repositories, { home, git, environment })
  report.checks.push(...checked.checks)
  if (exitCodeFor(checked.checks) !== EXIT.ok) return stop(exitCodeFor(checked.checks))
  if (kept && isDeepStrictEqual(kept, config)) {
    report.changed = false
    return report
  }
  const text = `${JSON.stringify(config, null, 2)}\n`
  if (Buffer.byteLength(text) > CONFIG_MAX_BYTES)
    return stop(EXIT.config, 'config is larger than 64 KiB')
  const problem = await directoryProblem(dirname(file), context.uid)
  if (problem) return stop(EXIT.config, problem)
  const temp = join(dirname(file), `.config-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      // The creation mode is masked by the caller's umask; set it outright.
      await handle.chmod(0o600)
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A first setup must not overwrite a config that appeared during detection.
    if (context.replace || kept) await rename(temp, file)
    else await link(temp, file)
  } catch (error) {
    if (!context.replace && error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return stop(
        EXIT.tempfail,
        'a config appeared while setup was running; rerun phosphor setup to see it',
      )
    }
    return stop(EXIT.internal, `could not write config: ${errorText(error)}`)
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
  const loaded = await loadHostConfig(file, context.uid)
  if (!loaded.ok) {
    report.notes.push(
      ...loaded.errors.map((error) => `${error.pointer || '(file)'}: ${error.message}`),
    )
    return stop(EXIT.internal, 'the written config could not be loaded')
  }
  report.changed = !kept || !isDeepStrictEqual(kept, config)
  if (context.tailscaleHints !== false)
    report.notes.push(
      ...setupTailscaleHint(
        await inspectTailscale(config, context.env, context.platform, context.tailscale),
      ),
    )
  report.next = 'phosphor setup'
  return report
}

/**
 * A found program's real folder, keeping its own name. Version managers put
 * per-shell links on PATH (fnm's multishell directory under /run/user is gone
 * at logout and differs in every shell), so the config pins what they point at.
 * Only the folder is resolved: the name may itself be a link pi or npm relies on.
 */
async function stable(found: string | null): Promise<string | null> {
  if (!found) return null
  const folder = await realpath(dirname(found)).catch(() => dirname(found))
  return join(folder, basename(found))
}

function summarize(report: SetupReport, config: HostConfigV1): void {
  report.pi = config.pi
  report.repositories = config.repositories
  report.path = config.environment?.path ?? []
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function directoryProblem(dir: string, uid: number | undefined): Promise<string | null> {
  if (uid === undefined) return 'the Host runs on Linux and macOS'
  // Folders are born 0700 under a private umask, so even a umask that drops
  // the owner's read bit leaves one setup can open without following links.
  const previous = process.umask(0o077)
  let replaced: string | null
  try {
    replaced = await createPrivate(dir, uid)
  } finally {
    process.umask(previous)
  }
  if (replaced) return replaced
  const info = await stat(dir)
  if (info.uid !== uid) return `${dir} belongs to uid ${info.uid}, not to you (${uid})`
  if (info.mode & 0o022) return `${dir} is writable by others: run chmod go-w ${dir}`
  return null
}

/**
 * Create `dir` and any missing parents as 0700, whatever the umask. Only the
 * folders created here are chmodded: an existing one is judged, not repaired.
 * The mode is set through a handle opened without following a symlink, so a
 * folder renamed and replaced between mkdir and chmod is refused, not chmodded.
 */
async function createPrivate(dir: string, uid: number): Promise<string | null> {
  const missing: string[] = []
  for (let path = dir; ; path = dirname(path)) {
    if (
      await lstat(path).then(
        () => true,
        (error: unknown) => !isMissing(error),
      )
    )
      break
    missing.unshift(path)
    if (dirname(path) === path) break
  }
  for (const path of missing) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
    let handle: FileHandle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    } catch {
      return `${path} changed while setup was creating it; rerun phosphor setup`
    }
    try {
      const info = await handle.stat()
      if (!info.isDirectory() || info.uid !== uid) {
        return `${path} changed while setup was creating it; rerun phosphor setup`
      }
      await handle.chmod(0o700)
    } finally {
      await handle.close()
    }
  }
  return null
}

export function renderSetup(report: SetupReport): string {
  const lines = [`config  ${report.config}`]
  if (report.pi)
    lines.push(
      `pi  ${report.pi.executable}${report.pi.version ? ` (pi ${report.pi.version})` : ''}`,
    )
  if (report.pi?.node)
    lines.push(
      `node  ${report.pi.node}${report.nodeVersion ? ` (node ${report.nodeVersion})` : ''}`,
    )
  for (const path of report.repositories ?? []) lines.push(`repository  ${path}`)
  for (const path of report.path ?? []) lines.push(`extra PATH  ${path}`)
  if (report.claude) lines.push(`claude  ${report.claude}`)
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' }
  for (const check of report.checks) {
    if (check.status === 'fail' || check.id === 'repository') {
      lines.push(`  ${mark[check.status]}  ${check.id.padEnd(15)} ${check.summary}`)
    }
  }
  lines.push(...report.notes)
  if (report.next) lines.push(`next: ${report.next}`)
  return `${lines.join('\n')}\n`
}
