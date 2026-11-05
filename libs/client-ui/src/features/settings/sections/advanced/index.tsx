import { AdvancedView } from './AdvancedView'
import { useHostAdvanced } from './useHostAdvanced'
import { useLocalAdvanced } from './useLocalAdvanced'

export function LocalAdvanced(): React.JSX.Element {
  return <AdvancedView source={useLocalAdvanced()} />
}

export function HostAdvanced(): React.JSX.Element {
  return <AdvancedView source={useHostAdvanced()} />
}
