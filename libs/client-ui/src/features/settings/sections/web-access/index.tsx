import { useHostWebAccess } from './useHostWebAccess'
import { useLocalWebAccess } from './useLocalWebAccess'
import { WebAccessView } from './WebAccessView'

export function LocalWebAccess(): React.JSX.Element {
  return <WebAccessView source={useLocalWebAccess()} />
}

export function HostWebAccess(): React.JSX.Element {
  return <WebAccessView source={useHostWebAccess()} />
}
