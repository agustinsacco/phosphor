import { useSettingsUiStore } from '../../settingsUiStore'
import { PackagesView } from './PackagesView'
import { useHostPackages } from './useHostPackages'
import { useLocalPackages } from './useLocalPackages'

/**
 * This Mac's Extensions, for the folder in scope or the whole machine. One
 * scope per mount, as in Agent: an old scope's read never lands on the new one.
 */
export function LocalExtensions(): React.JSX.Element {
  const folder = useSettingsUiStore((s) => s.folder)
  return <LocalExtensionsScope key={folder ?? 'machine'} folder={folder} />
}

function LocalExtensionsScope({ folder }: { folder: string | null }): React.JSX.Element {
  return <PackagesView source={useLocalPackages(folder)} />
}

/** A Host's Extensions, inside its Host section. */
export function HostExtensions(): React.JSX.Element {
  return <PackagesView source={useHostPackages()} />
}
