import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HOST_UNIT, serviceRunner } from '../machine/systemd'
import type { ServiceContext } from '../commands/service'

/** Set on the re-run, so an update never hands itself off twice. */
export const DETACHED_ENV = 'PHOSPHOR_UPDATE_DETACHED'

/** The variables an update reads; a transient unit otherwise sees only the user manager's. */
const PASSED = /^(?:PATH|HOME|LANG|XDG_[A-Z_]+|PHOSPHOR_[A-Z_]+)$/

/**
 * A Host lane's terminal or agent shell lives in the Host's own systemd unit, and
 * `systemctl restart` stops that unit's whole control group: the update would kill
 * itself mid-restart and roll back. Linux only; launchd has no such group.
 */
export function insideHostUnit(cgroup?: string): boolean {
  let text = cgroup
  try {
    text ??= readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return false
  }
  return text.split('\n').some((line) => line.endsWith(`/${HOST_UNIT}`))
}

interface DetachContext extends ServiceContext {
  update?: { node?: string; bundle?: string; cgroup?: string }
  now?: () => number
}

/** Only an update that restarts the service hands off; a check never does. */
export function shouldDetach(context: DetachContext, options: { check?: boolean }): boolean {
  return (
    !options.check &&
    context.platform === 'linux' &&
    !context.env[DETACHED_ENV] &&
    insideHostUnit(context.update?.cgroup)
  )
}

/** Re-runs this update in its own transient unit, which outlives the Host's restart. */
export async function detachUpdate(
  context: DetachContext,
  options: { version?: string; rollback?: boolean },
): Promise<number> {
  const unit = `phosphor-update-${(context.now ?? Date.now)()}.service`
  const runner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  const env = Object.entries(context.env)
    .filter(([name, value]) => PASSED.test(name) && value)
    .map(([name, value]) => `--setenv=${name}=${value}`)
  const result = await runner('systemd-run', [
    '--user',
    '--collect',
    '--quiet',
    `--unit=${unit}`,
    '--description=Phosphor Host update',
    ...env,
    `--setenv=${DETACHED_ENV}=1`,
    context.update?.node ?? process.execPath,
    context.update?.bundle ?? resolve(process.argv[1] ?? ''),
    'update',
    ...(options.version ? ['--version', options.version] : []),
    ...(options.rollback ? ['--rollback'] : []),
  ])
  if (result.code !== 0) {
    context.print(
      'This shell runs inside the Phosphor Host service, which an update restarts, and ' +
        'systemd-run could not start the update on its own. Run phosphor update over SSH.',
    )
    return 69
  }
  context.print(
    `This shell runs inside the Phosphor Host service, so the update continues as ${unit}. ` +
      'This session disconnects while the Host restarts; reconnect in a minute. ' +
      `Its result: journalctl --user -u ${unit}`,
  )
  return 0
}
