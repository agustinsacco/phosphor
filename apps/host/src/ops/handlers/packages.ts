import { isMachinePackageSpec } from '@phosphor/shared/machine-settings'
import { checkPackageUpdates } from '@phosphor/session-runtime/pi/package-updates'
import { op, dataResult } from '@phosphor/session-runtime/ops/results'
import { projectId, scopedProject, settingsOps, readSection } from './settings-access'
import type { HeadlessTask } from '../../settings/headless-tasks'
import type { DaemonHandlerDeps } from './index'

export function packageHandlers(deps: DaemonHandlerDeps) {
  const task = (name: HeadlessTask) =>
    op(async (a, c) => {
      const repo = projectId(deps, scopedProject(a.scope, a.project), c)
      const output = await settingsOps(deps).task(
        name,
        a.spec as string | undefined,
        repo,
        c.signal,
      )
      return { text: `Finished ${name}.\n${output}`, undo: false }
    })
  return {
    'package.list': op(async (a, c) =>
      dataResult(
        (await readSection(deps, 'resources', projectId(deps, a.project, c), c.signal)).resources
          ?.packages ?? [],
      ),
    ),
    'package.checkUpdates': op(async (a, c) => {
      const { resources } = await readSection(
        deps,
        'resources',
        projectId(deps, a.project, c),
        c.signal,
      )
      return dataResult(
        await checkPackageUpdates(
          (resources?.packages ?? []).flatMap(({ spec }) =>
            isMachinePackageSpec(spec) ? [{ spec, kind: 'npm' }] : [],
          ),
        ),
      )
    }),
    'package.install': task('package.install'),
    'package.update': task('package.update'),
    'package.remove': task('package.remove'),
    'claude.installProvider': task('claude.installProvider'),
    'claude.installCli': task('claude.installCli'),
  }
}
