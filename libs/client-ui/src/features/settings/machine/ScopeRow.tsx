import { useMemo } from 'react'
import { Segmented, Select, type SelectOption } from '@/components/form'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useSettingsWorkspace } from '../SettingsMachineScope'
import { useSettingsUiStore } from '../settingsUiStore'

/**
 * Machine or one folder, for the sections that have both (`scoped` in the
 * registry). Sits in the scope line; the section reads `folder` from the
 * Settings store. `guard` runs a change once unsaved work may be left.
 */
export function ScopeRow({
  folders,
  preferred,
  disabled = false,
  guard = (apply) => apply(),
}: {
  folders: readonly SelectOption[]
  /** The active lane's folder: Folder picks it when listed, else the first. */
  preferred?: string | null
  disabled?: boolean
  guard?: (apply: () => void) => void
}): React.JSX.Element {
  const folder = useSettingsUiStore((s) => s.folder)
  // A folder that left the list stays chosen and named until the user picks another.
  const options =
    folder !== null && !folders.some((option) => option.value === folder)
      ? [...folders, { value: folder, label: folder }]
      : folders
  const choose = (next: string | null): void =>
    guard(() => useSettingsUiStore.getState().setFolder(next))
  const first = options.find((option) => option.value === preferred) ?? options[0]
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="settings-scope-row">
      <Segmented
        label="Configuration scope"
        value={folder === null ? 'machine' : 'folder'}
        options={[
          { value: 'machine', label: 'Machine' },
          { value: 'folder', label: 'Folder', disabled: options.length === 0 },
        ]}
        disabled={disabled}
        onChange={(scope) => choose(scope === 'machine' ? null : (first?.value ?? null))}
      />
      {folder !== null && (
        // Wraps instead of shrinking: WebKit keeps a select at its longest option's width.
        <Select
          label="Configuration folder"
          value={folder}
          options={options}
          disabled={disabled}
          onChange={choose}
          className="max-w-[min(18rem,100%)] py-1"
        />
      )}
    </div>
  )
}

/** This Mac's folders: the settings workspace, then the recent workspaces. */
export function LocalScopeRow(): React.JSX.Element {
  const workspace = useSettingsWorkspace()
  const recents = useWorkspacesStore((s) => s.recents)
  const folders = useMemo(() => {
    const listed = recents.map((entry) => ({ value: entry.path, label: entry.name }))
    if (!workspace || listed.some((entry) => entry.value === workspace)) return listed
    return [
      { value: workspace, label: workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace },
      ...listed,
    ]
  }, [workspace, recents])
  return <ScopeRow folders={folders} preferred={workspace} />
}
