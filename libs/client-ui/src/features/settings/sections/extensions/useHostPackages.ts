import { useEffect } from 'react'
import type { MachineSettings } from '@shared/machine-settings'
import { useHostSection } from '../../machine/HostSection'
import { publishHostPackages } from './hostExtensionPackages'
import { openSkillsOn } from './openSkillsOn'
import type { PackageAction, PackageCaps, PackageItem, PackageSource } from './packageSource'

/** A Host manages npm packages for the whole machine, through reviewed tasks. */
const HOST_CAPS: PackageCaps = {
  anySource: false,
  projectScope: false,
  updateAll: false,
  versionCheck: false,
  headless: true,
}
const TASKS = {
  install: 'package.install',
  update: 'package.update',
  remove: 'package.remove',
} as const

type HostPackage = NonNullable<MachineSettings['resources']>['packages'][number]
const item = (pkg: HostPackage): PackageItem => ({
  spec: pkg.spec,
  name: pkg.name,
  version: pkg.version,
  scope: pkg.scope === 'project' ? 'project' : 'global',
  installed: pkg.installed,
  filtered: pkg.filtered === true,
  contents: pkg.installed && pkg.contents ? pkg.contents : null,
})

/**
 * A Host's packages, from its `resources` read for the folder in scope. Each
 * action is a reviewed task in a private terminal on the Host; the review
 * asks before a removal, and the section reads again when the task ends.
 */
export function useHostPackages(): PackageSource {
  const { machine, settings, programs, repositoryId } = useHostSection()
  const packages = settings.data?.resources?.packages
  useEffect(() => {
    if (packages) publishHostPackages(machine.id, packages)
  }, [machine.id, packages])
  return {
    caps: HOST_CAPS,
    packages: packages?.map(item) ?? null,
    failure: null,
    folder: repositoryId !== undefined,
    latest: {},
    claudeCli: null,
    busy: settings.loading || settings.saving || programs.busy || !programs.available,
    run: (action: PackageAction, spec: string | undefined) => {
      if (spec) programs.task({ task: TASKS[action], name: spec })
    },
    openSkills: () => openSkillsOn(machine.id),
    output: null,
  }
}
