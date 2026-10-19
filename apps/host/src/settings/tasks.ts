import { parseMachineTask } from '@phosphor/shared/machine-settings'
import { TerminalForbidden } from '../terminals/service'
import { runMachineTask, type MachineTaskOptions } from './task-program'

/** Receipt-backed, fixed-purpose programs in private PTYs. No caller argv, shell or env. */
export function createMachineTasks(options: MachineTaskOptions) {
  let active = false
  async function execute(raw: unknown, owner: string, authorized: () => boolean) {
    const op = parseMachineTask(raw)
    if (!op) throw new Error('bad-request')
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (active) throw new Error('busy')
    active = true
    return new Promise<{ terminalId: string }>((resolve, reject) => {
      let started = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      const run = options.terminals.loginRunner(
        owner,
        (id) => {
          started = true
          deadline = setTimeout(() => {
            try {
              options.terminals.machineOp(owner, { type: 'terminal.kill', terminalId: id })
            } catch {
              /* Already closed or revoked. */
            }
          }, 15 * 60_000)
          deadline.unref()
          resolve({ terminalId: id })
        },
        true,
        false,
        authorized,
      )
      void runMachineTask(options, op, run, authorized)
        .then(
          () => {
            if (!started) reject(new Error('unavailable'))
          },
          () => reject(new Error('unavailable')),
        )
        .finally(() => {
          if (deadline) clearTimeout(deadline)
          active = false
          options.settings.invalidateConnectors()
        })
    })
  }
  return { execute, active: () => active }
}
export type MachineTasks = ReturnType<typeof createMachineTasks>
