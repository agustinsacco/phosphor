import { supportedThinkingLevels } from '@shared/thinking'
import { machineLabel } from '@/stores/remoteLanes'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
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
  const openSettings = useOpenSettings()
  return (
    <StartModelPicker
      source={hostStartModel(selection, () => openSettings(selection.hostId, 'accounts'))}
    />
  )
}

/** Sign in goes where the chat's sign-in remedy goes: Settings → Accounts for the Host. */
function hostStartModel(selection: HostModelSelection, signIn: () => void): StartModelSource {
  const { model, hostId } = selection
  const actions: StartModelSource['actions'] = []
  if (selection.canRetry) actions.push({ label: 'Retry models', run: () => void selection.retry() })
  if (selection.missingModel)
    actions.push({ label: `Sign in on ${machineLabel(hostId)}`, run: signIn })
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
