import { isMachinePackageSpec, type MachineTaskOp } from '@phosphor/shared/machine-settings'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { runMachineTask, type MachineTaskOptions } from './task-program'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
export type HeadlessTask = Extract<
  MachineTaskOp['task'],
  `package.${string}` | 'claude.installCli' | 'claude.installProvider'
>

/** Only package administration may run headlessly. In particular never dispatch a login task. */
export function createHeadlessTasks(
  options: Omit<MachineTaskOptions, 'terminals'>,
  hide: (s: string) => string,
  busy: () => boolean = () => false,
) {
  let active = false
  const task = async (
    task: HeadlessTask,
    name: string | undefined,
    repositoryId: string | undefined,
    signal: AbortSignal,
  ) => {
    if (
      ![
        'package.install',
        'package.update',
        'package.remove',
        'claude.installCli',
        'claude.installProvider',
      ].includes(task) ||
      (task.startsWith('package.')
        ? !(isMachinePackageSpec(name) || (task === 'package.update' && name === undefined))
        : !!(name || repositoryId))
    )
      throw new OpRefusal('bad-request', 'Select a supported package task and npm package spec.')
    if (active || busy()) throw new OpRefusal('busy', 'Another machine task is running.')
    active = true
    let output = ''
    try {
      await runMachineTask(
        options,
        { type: 'machine.task', task, name, repositoryId },
        async (file, args, { cwd, env }) => {
          const result = await runPrintMode(file, [...args], {
            cwd,
            env,
            signal,
            timeoutMs: 15 * 60_000,
            stderr: 'capture',
            maxStderrBytes: 8192,
            maxOutputBytes: 32_768,
          })
          output = hide([result.stdout, result.stderr].filter(Boolean).join('\n')).slice(0, 32_768)
          if (result.error)
            throw new Error(`Task failed (${result.reason ?? 'unavailable'}). ${output}`)
          return { code: 0 }
        },
        () => !signal.aborted,
      )
      return output
    } finally {
      active = false
      options.settings.invalidateConnectors()
    }
  }
  return Object.assign(task, { active: () => active })
}
