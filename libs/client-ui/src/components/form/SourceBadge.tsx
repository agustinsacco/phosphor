import clsx from 'clsx'

/** Where a shown value comes from: this scope's own file, the machine scope, or pi itself. */
export type SettingSource = 'set-here' | 'inherited' | 'pi-default'

const SOURCES: Record<SettingSource, { label: string; className: string }> = {
  'set-here': { label: 'Set here', className: 'bg-accent-soft text-accent' },
  inherited: { label: 'Inherited from machine', className: 'bg-bg-secondary text-text-secondary' },
  'pi-default': { label: 'pi default', className: 'bg-bg-secondary text-text-tertiary' },
}

/** A small chip beside a value that says which scope set it. */
export function SourceBadge({ source }: { source: SettingSource }): React.JSX.Element {
  const { label, className } = SOURCES[source]
  return (
    <span
      data-setting-source={source}
      className={clsx(
        'shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-2xs font-medium',
        className,
      )}
    >
      {label}
    </span>
  )
}
