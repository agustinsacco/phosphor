import { useMachinesStore } from '@/stores/machines'
import { Button } from '@/components/form'
import { machineLabel } from '@/stores/remoteLanes'
import { RemoteModelChips } from './RemoteModelChips'
import type { useRemoteModel } from './useRemoteModel'
import './remoteModel.css'

export { useRemoteModel } from './useRemoteModel'

/**
 * The composer's model and thinking chips at every width, the same picker as
 * This Mac's home and every lane. A phone gets the shared menu as a sheet.
 */
export function RemoteModelPicker({
  selection,
}: {
  selection: ReturnType<typeof useRemoteModel>
}): React.JSX.Element {
  return (
    <div className="remote-model-picker">
      <RemoteModelChips selection={selection} />
      {selection.canRetry && (
        <Button size="sm" onClick={() => void selection.retry()}>
          Retry models
        </Button>
      )}
      {selection.missingModel && (
        <Button
          size="sm"
          onClick={() =>
            useMachinesStore.getState().show({ kind: 'machine', id: selection.hostId })
          }
        >
          Sign in on {machineLabel(selection.hostId)}
        </Button>
      )}
    </div>
  )
}
