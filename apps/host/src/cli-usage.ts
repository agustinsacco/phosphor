import { EXIT } from './checks'
import { launchdExit } from './machine/launchd'
import { createHostLog, hostLogDirectory } from './machine/log'

export const USAGE = `usage: phosphor <command>

Set up a Host: phosphor setup. Re-run it to resume or finish setup.

  setup [--repository DIR]... [--pi FILE] [--node FILE] [--replace]
        [--config FILE] [--json]    configure, sign in, start the user service and enable Tailscale
  doctor [--config FILE] [--json]   check that this machine can run a Host
  providers [--config FILE] [--json]
                                    show which providers pi can use here
  providers login PROVIDER [--config FILE]
                                    sign in to PROVIDER here, in this terminal, with
                                    its own login: a pi provider id, or claude for
                                    the claude lane
  accept --repository DIR [--lane native|claude|all] [--keep-transcripts]
         [--model ID [--provider NAME]] [--claude-model ID]
         [--config FILE] [--json]
                                    run real sessions in DIR, an empty repository
                                    from the config, and report what they proved;
                                    --provider and --model choose what the native
                                    lane runs on, --claude-model the Claude lane's
                                    model
  login [--config FILE]            add this machine to your Phosphor account
  status [--config FILE] [--json]   check this machine with the control plane
  logout [--config FILE] [--local]  remove it; --local only forgets it here
  run [--config FILE] [--supervisor launchd]
                                    keep this machine online with heartbeats
  service install|status|restart|logs|uninstall [--config FILE]
                                    manage the Linux or macOS user service; logs takes --follow
  tailscale status|enable|disable [--config FILE]
                                    expose the loopback API on your tailnet, never Funnel
  update [--version X.Y.Z] [--check] [--json]
  update --rollback [--json]        select the previous installed release offline
  uninstall [--purge --yes] [--json] remove the program and service; keep data by default
  version [--json]                  print the Host's version

exit codes: 0 ok, 1 an acceptance check failed, 64 usage, 69 prerequisite unavailable,
70 internal error, 75 control unavailable, code expired or concurrent setup, 77 machine removed,
78 config invalid, 128+n ended by signal n
`

/** Where a usage error is reported. */
export interface UsageTarget {
  stderr(text: string): void
  /** `run` under launchd, which must not restart a Host for a usage error. */
  supervised: boolean
  env: NodeJS.ProcessEnv
  home: string
  /** Read only when a supervised exit is recorded. */
  now: () => number
}

/**
 * Print the problem and the usage. A supervised run also logs the stop and
 * records the permanent exit, then exits 0 so launchd does not restart it.
 */
export async function refuseUsage(problem: string, target: UsageTarget): Promise<number> {
  target.stderr(`phosphor: ${problem}\n\n${USAGE}`)
  if (!target.supervised) return EXIT.usage
  try {
    const log = createHostLog(hostLogDirectory(target.env, target.home), [])
    log.write('service', 'stopped', { code: EXIT.usage })
    return await launchdExit(EXIT.usage, target.env, target.home, target.now())
  } catch {
    target.stderr('The service command could not finish.\n')
    return EXIT.tempfail
  }
}
