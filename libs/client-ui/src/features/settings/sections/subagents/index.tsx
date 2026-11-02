import { SubagentsView } from './SubagentsView'

export function LocalSubagents(): React.JSX.Element {
  return <SubagentsView rawEditor />
}

/** A Host has no raw editors: its Pi settings are not opened from here. */
export function HostSubagents(): React.JSX.Element {
  return <SubagentsView rawEditor={false} />
}
