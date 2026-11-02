import { useSettingsUiStore } from '../../settingsUiStore'
import { PackagesView } from './PackagesView'
import { useHostPackages } from './useHostPackages'
import { useLocalPackages } from './useLocalPackages'

/** This Mac's Extensions, for the folder in scope or the whole machine. */
export function LocalExtensions(): React.JSX.Element {
  const folder = useSettingsUiStore((s) => s.folder)
  return <PackagesView source={useLocalPackages(folder)} />
}

/** A Host's Extensions, inside its Host section. */
export function HostExtensions(): React.JSX.Element {
  return <PackagesView source={useHostPackages()} />
}
