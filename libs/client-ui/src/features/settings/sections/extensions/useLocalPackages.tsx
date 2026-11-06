import { useCallback, useState } from 'react'
import type { PiPackageEntry } from '@shared/models'
import { errorText } from '@shared/errors'
import { promptChoice } from '@/stores/prompt'
import { JobOutput } from '../../JobOutput'
import { usePackageJob } from '../../usePackageJob'
import { openSkillsOn } from './openSkillsOn'
import type { PackageAction, PackageCaps, PackageItem, PackageSource } from './packageSource'
import { useLocalRead } from '../../machine/ScopeRefresh'
import { publishPackageList } from './extensionPackageLists'

const LOCAL_CAPS: PackageCaps = {
  anySource: true,
  projectScope: true,
  updateAll: true,
  versionCheck: true,
  headless: false,
}

const item = (entry: PiPackageEntry): PackageItem => ({
  spec: entry.spec,
  name: entry.name,
  version: entry.version,
  scope: entry.scope,
  installed: entry.installed,
  filtered: entry.filtered,
  contents: entry.installed ? entry.resources : null,
})

/** Confirms a removal: pi deletes the package and its settings entry. */
async function confirmRemove(spec: string): Promise<boolean> {
  return (
    (await promptChoice({
      title: `Remove ${spec}?`,
      message: 'pi removes the package and its settings entry. New sessions no longer load it.',
      choices: [{ value: 'remove', label: 'Remove', primary: true }],
    })) === 'remove'
  )
}

/**
 * This Mac's packages, for `folder` (a workspace path) or the whole machine:
 * reads from pi's settings and install dirs, actions through pi's own package
 * manager with the output streamed in place. Each read is published for the
 * nested Extensions items. `versions: false` skips the registry's latest versions.
 */
export function useLocalPackages(
  folder: string | null,
  { versions = true }: { versions?: boolean } = {},
): PackageSource {
  const [packages, setPackages] = useState<PackageItem[] | null>(null)
  const [latest, setLatest] = useState<Record<string, string | null>>({})
  const [claudeCli, setClaudeCli] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const workspace = folder ?? undefined

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const [list, detect] = await Promise.all([
        window.phosphor.invoke('packages:list', workspace),
        window.phosphor.invoke('packages:detect'),
      ])
      setPackages(list.map(item))
      publishPackageList('local', folder, list)
      setClaudeCli(detect.claude)
      if (!versions) return
      // The registry is slower than the local reads and may fail (offline,
      // a private registry): it never blocks the listing.
      window.phosphor
        .invoke('packages:checkUpdates', workspace)
        .then(setLatest)
        .catch(() => setLatest({}))
    } catch (err) {
      setError(errorText(err))
    }
  }, [folder, workspace, versions])

  useLocalRead(refresh)

  const job = usePackageJob(() => void refresh())
  const run = (
    action: PackageAction,
    spec: string | undefined,
    scope: 'global' | 'project',
  ): void => {
    const start = async (): Promise<void> => {
      if (action === 'remove' && spec && !(await confirmRemove(spec))) return
      setError(null)
      await job.start(() => window.phosphor.invoke('packages:run', action, spec, scope, workspace))
    }
    start().catch((err: unknown) => setError(errorText(err)))
  }

  return {
    caps: versions ? LOCAL_CAPS : { ...LOCAL_CAPS, versionCheck: false },
    status:
      packages !== null ? 'ready' : error ? { error, retry: () => void refresh() } : 'loading',
    packages,
    folder: folder !== null,
    latest,
    claudeCli,
    busy: job.running,
    run,
    openSkills: () => openSkillsOn('local'),
    output: (
      <>
        {error && packages !== null && <div className="text-danger mt-3 text-base">{error}</div>}
        <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />
      </>
    ),
  }
}
