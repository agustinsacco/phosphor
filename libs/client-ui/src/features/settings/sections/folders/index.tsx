import { FoldersView } from './FoldersView'
import { useHostFolders } from './useHostFolders'
import { useLocalFolders } from './useLocalFolders'

export function LocalFolders(): React.JSX.Element {
  return <FoldersView source={useLocalFolders()} />
}

export function HostFolders(): React.JSX.Element {
  return <FoldersView source={useHostFolders()} />
}
