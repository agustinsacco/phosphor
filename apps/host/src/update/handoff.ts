import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'
import { HOST_UNIT } from '@phosphor/shared/host-local'
import { serviceRunner, type ServiceRunner } from '../machine/systemd'
import type { UpdateContext, UpdateOptions } from '../commands/update'
import { fetchSignedRelease, UpdateFailure } from '@phosphor/session-runtime/host-install/fetch'
import { commandLayout } from '@phosphor/session-runtime/host-install/layout'
import { hostStateDirectory } from '../lanes/state-dir'
import { servicePid, startUpdateJob, updateJob } from './launchd-job'
import { HOST_PID_ENV } from './host-pid'

/** The transient unit an update moves into when the shell that started it is inside the Host. */
export const UPDATE_UNIT = 'phosphor-host-update'

export const HANDOFF_FAILED =
  'Could not move the update out of the Host service. Run phosphor update from a shell outside Phosphor.'

/** The variables the updater reads, passed on so the handed-off run sees what this one saw. */
const PASSED_ENV = [
  'HOME',
  'PATH',
  'PHOSPHOR_HOST_RELEASE_URL',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
]

/**
 * The Machines page's `host.update` task: this Host's installed release runs
 * `update` in a private terminal, where the handoff below moves it out of the
 * service. null where a button must not start it: a source install has no
 * release to replace.
 *
 * `env` adds only the updater's variables to pi's environment. systemd-run
 * reaches the user manager through XDG_RUNTIME_DIR or the session bus; on
 * macOS `PHOSPHOR_HOST_PID` names this service, so the updater knows it runs
 * inside it.
 */
export function hostUpdateProgram(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  node?: string,
  bundle?: string,
  pid: number = process.pid,
): { node: string; bundle: string; env: Record<string, string> } | null {
  const layout = commandLayout(home, node, bundle)
  if (!layout || (platform !== 'linux' && platform !== 'darwin')) return null
  const folder = join(layout.lib, 'versions', layout.version)
  const passed = PASSED_ENV.filter((name) => name !== 'HOME' && name !== 'PATH')
  const names =
    platform === 'linux' ? [...passed, 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] : passed
  return {
    node: join(folder, 'node/bin/node'),
    bundle: join(folder, 'lib/phosphor.mjs'),
    env: {
      ...Object.fromEntries(
        names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]!]])),
      ),
      ...(platform === 'darwin' ? { [HOST_PID_ENV]: String(pid) } : {}),
    },
  }
}

/**
 * Is this process inside the Host's own systemd unit?
 *
 * A Host terminal's shell is: the Host spawns it, so it lives in the unit's
 * cgroup. Restarting the unit then stops every process in that cgroup,
 * including the updater mid-restart, which used to roll the new release
 * straight back. cgroup v1 and v2 both put the path after the second colon.
 */
export function insideHostUnit(
  read: () => string = () => readFileSync('/proc/self/cgroup', 'utf8'),
): boolean {
  try {
    return read()
      .split('\n')
      .some((line) => line.split(':').slice(2).join(':').split('/').includes(HOST_UNIT))
  } catch {
    return false
  }
}

/**
 * Is this process inside the macOS service? Every terminal and lane the
 * service spawns carries `PHOSPHOR_HOST_PID`; inside means it names the pid
 * launchd runs the service as. Without the variable launchd is never asked.
 */
export async function insideHostAgent(
  env: Readonly<Record<string, string | undefined>>,
  runner: ServiceRunner,
  uid: number | undefined,
): Promise<boolean> {
  const named = env[HOST_PID_ENV]
  if (!named || !/^[1-9][0-9]{0,9}$/.test(named)) return false
  return (await servicePid(runner, uid).catch(() => null)) === Number(named)
}

/** The updater's own command line, in the installed release, for the handed-off run. */
function handedOffCommand(folder: string, options: UpdateOptions): string[] {
  const { version, rollback, apply } = options
  return [
    join(folder, 'node/bin/node'),
    join(folder, 'lib/phosphor.mjs'),
    'update',
    // `update` takes no --config: the config path follows the XDG variables passed on.
    ...(rollback
      ? ['--rollback']
      : apply
        ? ['--apply', apply]
        : version
          ? ['--version', version]
          : []),
  ]
}

/** Linux: a transient user unit outside the Host's cgroup; its report goes to the journal. */
async function systemdHandoff(
  context: UpdateContext,
  runner: ServiceRunner,
  command: string[],
): Promise<string[] | null> {
  const setenv = PASSED_ENV.flatMap((name) => {
    const value = context.env[name]
    return value === undefined ? [] : [`--setenv=${name}=${value}`]
  })
  const args = ['--user', `--unit=${UPDATE_UNIT}`, '--collect', '--quiet', ...setenv, '--']
  const result = await runner('systemd-run', [...args, ...command]).catch(() => ({ code: null }))
  if (result.code !== 0) return null
  return [
    'This shell runs inside the Phosphor Host, which the update restarts.',
    `The update continues in the ${UPDATE_UNIT} unit; this terminal closes when the Host restarts.`,
    `Follow it with: journalctl --user -u ${UPDATE_UNIT}`,
  ]
}

/** macOS: a one-shot launchd job under the state folder; its report goes to the job's log. */
async function launchdHandoff(
  context: UpdateContext,
  runner: ServiceRunner,
  command: string[],
): Promise<string[] | null> {
  const job = updateJob(hostStateDirectory(context.env, context.home), context.update?.jobLabel)
  const env = Object.fromEntries(
    PASSED_ENV.flatMap((name) => {
      const value = context.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  if (!(await startUpdateJob(runner, context.uid, job, command, env).catch(() => false)))
    return null
  return [
    'This shell runs inside the Phosphor service, which the update restarts.',
    `The update continues in the ${job.label} launchd job; this terminal closes when the service restarts.`,
    `Follow it with: tail -f ${job.log}`,
  ]
}

/** The newer release a plain update would install, or the exit code that ends this run here. */
async function releaseToHandOff(
  context: UpdateContext,
  installed: string,
): Promise<{ found: string } | { code: number } | null> {
  const source = { ...context, ...context.update }
  const signal = context.signal ?? new AbortController().signal
  try {
    const release = await fetchSignedRelease(source, undefined, installed, signal)
    return release.version === installed ? null : { found: release.version }
  } catch (error) {
    // Not run here: a retry that succeeded would restart the Host from inside its service.
    if (signal.aborted) return { code: typeof signal.reason === 'number' ? signal.reason : 70 }
    context.print(
      error instanceof UpdateFailure
        ? error.message
        : 'Could not check for a Host release; nothing changed.',
    )
    return { code: error instanceof UpdateFailure ? error.exitCode : 75 }
  }
}

/**
 * An update, apply or rollback typed into a terminal (or a lane) inside the
 * service runs again outside it, so the service restart, the health check and
 * any rollback all outlive the terminal: on Linux as a transient user unit, on
 * macOS as a one-shot launchd job.
 *
 * A plain update checks the signed manifest first and says what it found, so
 * a terminal started from the Machines page shows the outcome. A failed check
 * is reported here and hands nothing off. When the Host is current it runs
 * here: nothing restarts, and `runUpdate` says so in this terminal.
 *
 * null: run here. `--check` and `--stage` restart nothing, and a source install
 * or invalid options are for `runUpdate` to refuse, in this terminal.
 */
export async function handOffFromHost(
  context: UpdateContext,
  options: UpdateOptions,
): Promise<number | null> {
  const { version, rollback, check, stage, apply } = options
  const layout = commandLayout(context.home, context.update?.node, context.update?.bundle)
  const valid = (v: string | undefined) => v === undefined || HOST_RELEASE_VERSION_PATTERN.test(v)
  if (!layout || check || stage || (rollback && version !== undefined) || !valid(version))
    return null
  if (!valid(apply) || (apply !== undefined && (rollback || version !== undefined))) return null
  if (context.platform !== 'linux' && context.platform !== 'darwin') return null
  const runner: ServiceRunner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  const inside =
    context.platform === 'linux'
      ? insideHostUnit(context.update?.cgroup)
      : await insideHostAgent(context.env, runner, context.uid)
  if (!inside) return null
  let found: string | undefined
  if (!rollback && version === undefined && apply === undefined) {
    const release = await releaseToHandOff(context, layout.version)
    if (!release) return null
    if ('code' in release) return release.code
    found = release.found
  }
  const command = handedOffCommand(join(layout.lib, 'versions', layout.version), options)
  const handOff = context.platform === 'linux' ? systemdHandoff : launchdHandoff
  const lines = await handOff(context, runner, command)
  if (!lines) {
    context.print(HANDOFF_FAILED)
    return 75
  }
  if (found) context.print(`Installed: ${layout.version}; available: ${found}`)
  for (const line of lines) context.print(line)
  context.print('Then check the version with: phosphor version')
  return 0
}
