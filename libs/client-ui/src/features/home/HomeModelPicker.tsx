import { StartModelPicker } from './StartModelPicker'
import { useLocalStartModel } from './useLocalStartModel'

/** This Mac's new-lane model picker: pi's catalogue and defaults, or the draft's own model. */
export function HomeModelPicker(
  props: Parameters<typeof useLocalStartModel>[0],
): React.JSX.Element {
  return <StartModelPicker source={useLocalStartModel(props)} />
}
