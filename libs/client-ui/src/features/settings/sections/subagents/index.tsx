import { SubagentsView } from './SubagentsView'

export function LocalSubagents(): React.JSX.Element {
  return <SubagentsView rawEditor machineDirectives={false} />
}

/**
 * A Host has no raw editors: its Pi settings are not opened from here. Its
 * directives exist only at machine scope.
 */
export function HostSubagents(): React.JSX.Element {
  return <SubagentsView rawEditor={false} machineDirectives />
}
