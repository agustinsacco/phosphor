import { ConnectorsView } from './ConnectorsView'
import { useHostConnectors } from './useHostConnectors'
import { useLocalConnectors } from './useLocalConnectors'

/** Settings → MCP Connectors on This Mac. */
export function LocalConnectors(): React.JSX.Element {
  return <ConnectorsView source={useLocalConnectors()} />
}

/** Settings → MCP Connectors on a Host, inside its section frame. */
export function HostConnectors(): React.JSX.Element {
  return <ConnectorsView source={useHostConnectors()} />
}
