import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'
import { HOST_UNIT, serviceRunner, type ServiceRunner } from '../machine/systemd'
import type { UpdateContext, UpdateOptions } from '../commands/update'
import { fetchSignedRelease, UpdateFailure } from './fetch'
import { commandLayout } from './layout'

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
 * unit. null where a button must not start it: a source install has no
 * release to replace, and macOS has no handoff, so its restart would end the
 * updater before the health check that rolls a broken release back.
 *
 * `env` adds only the updater's variables to pi's environment. systemd-run
 * reaches the user manager through XDG_RUNTIME_DIR or the session bus.
 */
export function hostUpdateProgram(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  node?: string,
  bundle?: string,
): { node: string; bundle: string; env: Record<string, string> } | null {
  const layout = commandLayout(home, node, bundle)
  if (!layout || platform !== 'linux') return null
  const folder = join(layout.lib, 'versions', layout.version)
  const names = [
    ...PASSED_ENV.filter((name) => name !== 'HOME' && name !== 'PATH'),
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]
  return {
    node: join(folder, 'node/bin/node'),
    bundle: join(folder, 'lib/phosphor.mjs'),
    env: Object.fromEntries(
      names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]!]])),
    ),
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
 * On Linux, an update or rollback typed into a Host terminal runs again as a
 * transient user unit outside the Host's cgroup, so the service restart, the
 * health check and any rollback all outlive the terminal. Its report goes to
 * the journal: this shell is gone by the time it is written.
 *
 * A plain update checks the signed manifest first and says what it found, so
 * a terminal started from the Machines page shows the outcome. A failed check
 * is reported here and hands nothing off. When the Host is current it runs
 * here: nothing restarts, and `runUpdate` says so in this terminal.
 *
 * null: run here. `--check` restarts nothing, and a source install or invalid
 * options are for `runUpdate` to refuse, in this terminal.
 */
export async function handOffFromHost(
  context: UpdateContext,
  options: UpdateOptions,
): Promise<number | null> {
  const { version, rollback, check } = options
  const layout = commandLayout(context.home, context.update?.node, context.update?.bundle)
  if (
    !layout ||
    check ||
    (rollback && version !== undefined) ||
    (version !== undefined && !HOST_RELEASE_VERSION_PATTERN.test(version)) ||
    context.platform !== 'linux' ||
    !insideHostUnit(context.update?.cgroup)
  )
    return null
  let found: string | undefined
  if (!rollback && version === undefined) {
    const source = { ...context, ...context.update }
    const signal = context.signal ?? new AbortController().signal
    let release: Awaited<ReturnType<typeof fetchSignedRelease>>
    try {
      release = await fetchSignedRelease(source, undefined, layout.version, signal)
    } catch (error) {
      // Not run here: a retry that succeeded would restart the Host from inside its unit.
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof UpdateFailure
          ? error.message
          : 'Could not check for a Host release; nothing changed.',
      )
      return error instanceof UpdateFailure ? error.exitCode : 75
    }
    if (release.version === layout.version) return null
    found = release.version
  }
  const runner: ServiceRunner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  const folder = join(layout.lib, 'versions', layout.version)
  const setenv = PASSED_ENV.flatMap((name) => {
    const value = context.env[name]
    return value === undefined ? [] : [`--setenv=${name}=${value}`]
  })
  const args = [
    '--user',
    `--unit=${UPDATE_UNIT}`,
    '--collect',
    '--quiet',
    ...setenv,
    '--',
    join(folder, 'node/bin/node'),
    join(folder, 'lib/phosphor.mjs'),
    'update',
    // `update` takes no --config: the config path follows the XDG variables passed above.
    ...(rollback ? ['--rollback'] : version ? ['--version', version] : []),
  ]
  const result = await runner('systemd-run', args).catch(() => ({ code: null }))
  if (result.code !== 0) {
    context.print(HANDOFF_FAILED)
    return 75
  }
  if (found) context.print(`Installed: ${layout.version}; available: ${found}`)
  context.print('This shell runs inside the Phosphor Host, which the update restarts.')
  context.print(
    `The update continues in the ${UPDATE_UNIT} unit; this terminal closes when the Host restarts.`,
  )
  context.print(`Follow it with: journalctl --user -u ${UPDATE_UNIT}`)
  context.print('Then check the version with: phosphor version')
  return 0
}
