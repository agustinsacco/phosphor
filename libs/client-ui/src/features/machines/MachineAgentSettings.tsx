import { Button } from '@/components/form'
import type { HostSettingsState } from './useHostSettings'

import { MachineHostPolicy, MachineModelDefaults } from './MachineAgentSections'
import { useMachineAgentSettings } from './useMachineAgentSettings'
export function MachineAgentSettings({
  hostId,
  label,
  settings,
  repositoryId,
}: {
  hostId: string
  label: string
  settings: HostSettingsState
  repositoryId?: string
}): React.JSX.Element | null {
  const controller = useMachineAgentSettings(hostId, repositoryId, settings, label)
  const { state, draft } = controller
  if (!state) return null
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Agent defaults</h2>
        <p className="text-text-secondary mt-1 text-base">
          Starting choices for new lanes on {label}. Explicit lane choices take precedence.
        </p>
      </div>
      {repositoryId && settings.data?.projectTrusted === false && (
        <p className="text-warning text-base">
          This folder is not trusted by pi on {label}. Folder defaults can be saved, but will not
          apply until project trust is explicitly approved under Folders. Machine defaults remain
          active.
        </p>
      )}
      {draft.stale && (
        <div role="alert" className="text-warning space-y-2 text-base">
          <p>
            The Host settings changed while you were editing. Your draft is kept, but it cannot
            overwrite the newer revision.
          </p>
          <Button size="sm" onClick={draft.discard}>
            Discard draft and use current settings
          </Button>
        </div>
      )}
      <MachineModelDefaults controller={controller} label={label} settings={settings} />
      {!repositoryId && <MachineHostPolicy controller={controller} label={label} />}
    </div>
  )
}
