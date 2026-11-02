import { Button } from '@/components/form'
import type { HostSettingsState } from './useHostSettings'

import { MachineHostPolicy, MachineModelDefaults } from './MachineAgentSections'
import { useMachineAgentSettings, type MachineAgentController } from './useMachineAgentSettings'
import { MachineAgentBehavior } from './MachineAgentBehavior'
import { Spinner } from './MachineUi'
import { MachineDirectives } from './MachineDirectives'
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
  if (!controller.state) return null
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Agent defaults</h2>
        <p className="text-text-secondary mt-1 text-base">
          Starting choices for new lanes on {label}. Explicit lane choices take precedence. Changes
          save automatically.
        </p>
      </div>
      {repositoryId && settings.data?.projectTrusted === false && (
        <p className="text-warning text-base">
          This folder is not trusted by pi on {label}. Folder defaults can be saved, but will not
          apply until project trust is explicitly approved under Folders. Machine defaults remain
          active.
        </p>
      )}
      <AutosaveState controller={controller} label={label} />
      <MachineModelDefaults controller={controller} label={label} />
      {settings.data?.agentBehaviorSupported ? (
        <MachineAgentBehavior controller={controller} label={label} />
      ) : (
        <p className="text-text-secondary text-base">
          Update this Host to configure compaction, retry and message delivery.
        </p>
      )}
      {!repositoryId &&
        (controller.state.agentDirectives ? (
          <MachineDirectives controller={controller} hostId={hostId} label={label} />
        ) : (
          <p className="text-text-secondary text-base">
            Update this Host to edit its global instructions and directives.
          </p>
        ))}
      {!repositoryId && <MachineHostPolicy controller={controller} label={label} />}
    </div>
  )
}

/**
 * Saving, or what the Host did not take (its reason is the section error above);
 * a successful save is announced by a toast.
 */
function AutosaveState({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element | null {
  const { draft, saving } = controller
  if (draft.stale)
    return (
      <div role="alert" className="text-warning space-y-2 text-base">
        <p>
          The Host settings changed while you were editing. Your unsaved changes are kept, but they
          cannot overwrite the newer revision.
        </p>
        <Button size="sm" onClick={draft.discard}>
          Discard draft and use current settings
        </Button>
      </div>
    )
  if (draft.unsaved)
    return (
      <div role="alert" className="border-danger/30 bg-danger-soft space-y-2 rounded-lg border p-3">
        <p className="text-danger text-base font-medium">
          Some changes are not saved on {label}. They are kept here until you try again or discard
          them.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={saving} onClick={draft.retry}>
            Try again
          </Button>
          <Button size="sm" disabled={saving} onClick={draft.discard}>
            Discard changes
          </Button>
        </div>
      </div>
    )
  return (
    <p role="status" className="text-text-tertiary flex min-h-5 items-center gap-2 text-sm">
      {saving && (
        <>
          <Spinner />
          Saving on {label}…
        </>
      )}
    </p>
  )
}
