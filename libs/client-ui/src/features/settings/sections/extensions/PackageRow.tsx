import { TooltipButton } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { isNewerVersion } from '@shared/version'
import { PACKAGE_CONTENT_KINDS, type PackageItem, type PackageSource } from './packageSource'

/**
 * One installed or declared package: its version, a newer version when the
 * machine checks, what it brings, and the actions the machine allows on it.
 */
export function PackageRow({
  pkg,
  source,
}: {
  pkg: PackageItem
  source: PackageSource
}): React.JSX.Element {
  const { caps, busy } = source
  const latest = source.latest[pkg.spec] ?? null
  const newer = latest !== null && pkg.version !== undefined && isNewerVersion(latest, pkg.version)
  const managed =
    (caps.anySource || pkg.spec.startsWith('npm:')) && (pkg.scope === 'global' || caps.projectScope)
  const update = managed && pkg.installed && (caps.versionCheck ? newer : true)
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-lg font-medium">{pkg.name}</span>
          {pkg.version && (
            <span className="text-text-tertiary font-mono text-sm">v{pkg.version}</span>
          )}
          {newer && (
            <span className="text-accent bg-accent-soft rounded-full px-2 py-0.5 font-mono text-sm">
              v{latest} available
            </span>
          )}
          {!pkg.installed && (
            <span className="text-warning text-sm">installs on next session start</span>
          )}
          {pkg.filtered && (
            <span
              className="text-text-tertiary text-sm"
              data-tooltip="Resource filters in settings"
            >
              filtered
            </span>
          )}
        </div>
        <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm">{pkg.spec}</div>
        {pkg.contents && <PackageContents contents={pkg.contents} source={source} />}
      </div>
      {managed && (
        <div className="flex shrink-0 items-center gap-1">
          {!pkg.installed && (
            <Button
              size="xs"
              onClick={() => source.run('install', pkg.spec, pkg.scope)}
              disabled={busy}
            >
              Repair installation
            </Button>
          )}
          {update && (
            <Button
              variant="primary"
              size="xs"
              onClick={() => source.run('update', pkg.spec, pkg.scope)}
              disabled={busy}
            >
              Update
            </Button>
          )}
          <TooltipButton
            onClick={() => source.run('remove', pkg.spec, pkg.scope)}
            disabled={busy}
            className="text-danger hover:bg-danger-soft rounded-md px-2 py-1 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Remove
          </TooltipButton>
        </div>
      )}
    </div>
  )
}

/**
 * What a package brings: names, when the machine reports them, with a jump to
 * the Skills page where its skills group under it; else counts. Read from the
 * install dir, so a "filtered" entry may load less.
 */
function PackageContents({
  contents,
  source,
}: {
  contents: NonNullable<PackageItem['contents']>
  source: PackageSource
}): React.JSX.Element {
  const count = (value: readonly string[] | number): number =>
    typeof value === 'number' ? value : value.length
  const rows = PACKAGE_CONTENT_KINDS.filter(([kind]) => count(contents[kind]) > 0)
  if (rows.length === 0) {
    return <div className="text-text-tertiary mt-1 text-sm">No resources found</div>
  }
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {rows.map(([kind, label]) => {
        const value = contents[kind]
        return (
          <div key={kind} className="contents">
            <dt className="text-text-tertiary">
              {label} ({count(value)})
            </dt>
            <dd className="text-text-secondary min-w-0 font-mono break-words">
              {typeof value !== 'number' &&
                value.map((name) => (kind === 'prompts' ? `/${name}` : name)).join(', ')}
              {kind === 'skills' && (
                <TooltipButton
                  onClick={source.openSkills}
                  className="text-accent ml-2 font-sans hover:underline"
                >
                  View in Skills
                </TooltipButton>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
