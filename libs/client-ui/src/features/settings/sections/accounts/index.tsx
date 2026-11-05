import { ProviderAccounts } from './ProviderAccounts'
import { useHostProviders } from './useHostProviders'
import { useLocalProviders } from './useLocalProviders'

/** This Mac's Accounts. */
export function LocalAccounts(): React.JSX.Element {
  return <ProviderAccounts source={useLocalProviders()} />
}

/** A Host's Accounts, under its gate. */
export function HostAccounts(): React.JSX.Element {
  return <ProviderAccounts source={useHostProviders()} />
}
