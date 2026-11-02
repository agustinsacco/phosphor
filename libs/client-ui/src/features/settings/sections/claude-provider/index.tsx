import { ClaudeProviderView } from './ClaudeProviderView'
import { useHostClaudeAccounts } from './useHostClaudeAccounts'
import { useLocalClaudeAccounts } from './useLocalClaudeAccounts'

/** This Mac's Claude Code page. */
export function LocalClaudeProvider(): React.JSX.Element {
  return <ClaudeProviderView source={useLocalClaudeAccounts()} />
}

/** A Host's Claude Code page, under its gate. */
export function HostClaudeProvider(): React.JSX.Element {
  return <ClaudeProviderView source={useHostClaudeAccounts()} />
}
