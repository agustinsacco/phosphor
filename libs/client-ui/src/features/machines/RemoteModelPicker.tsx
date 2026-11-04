import { supportedThinkingLevels } from '@shared/thinking'
import { useMachinesStore } from '@/stores/machines'
import { machineLabel } from '@/stores/remoteLanes'
import { StartModelPicker, type StartModelSource } from '@/features/home/StartModelPicker'
import type { useRemoteModel } from './useRemoteModel'

export { useRemoteModel } from './useRemoteModel'

type HostModelSelection = ReturnType<typeof useRemoteModel>

/** A Host's new-lane model picker: its catalogue, with the picks remembered for it. */
export function RemoteModelPicker({
  selection,
}: {
  selection: HostModelSelection
}): React.JSX.Element {
  return <StartModelPicker source={hostStartModel(selection)} />
}

function hostStartModel(selection: HostModelSelection): StartModelSource {
  const { model, hostId } = selection
  const actions: StartModelSource['actions'] = []
  if (selection.canRetry) actions.push({ label: 'Retry models', run: () => void selection.retry() })
  if (selection.missingModel)
    actions.push({
      label: `Sign in on ${machineLabel(hostId)}`,
      run: () => useMachinesStore.getState().show({ kind: 'machine', id: hostId }),
    })
  return {
    testIdPrefix: 'remote',
    models: selection.models,
    current: model,
    chip: model
      ? { text: model.name, tone: 'normal', title: `${model.name} · ${selection.explanation}` }
      : { text: selection.hint, tone: 'muted', title: selection.hint },
    loading: false,
    levels: model ? supportedThinkingLevels(model) : [],
    thinking: selection.thinking,
    choose: selection.choose,
    setThinking: selection.setThinking,
    menu: { emptyText: selection.hint, unavailable: selection.unavailable },
    actions,
  }
}
