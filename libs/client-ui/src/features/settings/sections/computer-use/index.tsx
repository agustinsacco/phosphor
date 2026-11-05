import { ComputerUseView } from './ComputerUseView'

export function LocalComputerUse(): React.JSX.Element {
  return <ComputerUseView onHost={false} />
}

/** Listed on a Host only while pi's settings there name the package: Hosts never offer it. */
export function HostComputerUse(): React.JSX.Element {
  return <ComputerUseView onHost />
}
