import { useEffect, useState } from 'react'
import type { MachineSettings } from '@shared/machine-settings'
import { useHostSection } from '../../machine/HostSection'
import { publishPackageList } from './extensionPackageLists'
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
 * Whether the Host's `claude` CLI is installed (`hosts:claude`), read again with
 * every package read, so an install task's end clears the warning. Null when unknown.
 */
function useHostClaudeCli(hostId: string, read: unknown): boolean | null {
  const [cli, setCli] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    window.phosphor.invoke('hosts:claude', hostId).then(
      (claude) => live && setCli(claude ? claude.cli === 'ok' : null),
      () => live && setCli(null),
    )
    return () => {
      live = false
    }
  }, [hostId, read])
  return cli
}

/**
 * A Host's packages, from its `resources` read for the folder in scope. Each
 * action is a reviewed task in a private terminal on the Host; the review
 * asks before a removal, and the section reads again when the task ends.
 */
export function useHostPackages(): PackageSource {
  const { machine, settings, programs, repositoryId } = useHostSection()
  const packages = settings.data?.resources?.packages
  const claudeCli = useHostClaudeCli(machine.id, settings.data)
  useEffect(() => {
    if (packages) publishPackageList(machine.id, repositoryId ?? null, packages)
  }, [machine.id, repositoryId, packages])
  return {
    caps: HOST_CAPS,
    status: packages ? 'ready' : 'loading',
    packages: packages?.map(item) ?? null,
    folder: repositoryId !== undefined,
    latest: {},
    claudeCli,
    busy: settings.loading || settings.saving || programs.busy || !programs.available,
    run: (action: PackageAction, spec: string | undefined) => {
      if (spec) programs.task({ task: TASKS[action], name: spec })
    },
    openSkills: () => openSkillsOn(machine.id),
    output: null,
  }
}
