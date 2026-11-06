import { Tag } from './Tag'

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
    <Tag data-setting-source={source} className={className}>
      {label}
    </Tag>
  )
}
