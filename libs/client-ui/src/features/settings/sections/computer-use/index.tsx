import { ComputerUseView } from './ComputerUseView'

export function LocalComputerUse(): React.JSX.Element {
  return <ComputerUseView onHost={false} />
}

/** Listed on a Host only while the package is installed there: Hosts never offer it. */
export function HostComputerUse(): React.JSX.Element {
  return <ComputerUseView onHost />
}
