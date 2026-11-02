import { useHostSection } from '../../machine/HostSection'
import { useSettingsUiStore } from '../../settingsUiStore'
import { AgentSettingsView } from './AgentSettingsView'
import { useHostAgent } from './useHostAgent'
import { useLocalAgent } from './useLocalAgent'

/*
 * One scope per mount: choosing another folder starts its read, and on a
 * Host its draft, from scratch.
 */

/** Settings → Agent on This Mac. */
export function LocalAgent(): React.JSX.Element {
  const folder = useSettingsUiStore((s) => s.folder)
  return <LocalAgentScope key={folder ?? 'machine'} />
}

/** Settings → Agent on a Host, under its gate. */
export function HostAgent(): React.JSX.Element {
  const { repositoryId } = useHostSection()
  return <HostAgentScope key={repositoryId ?? 'machine'} />
}

function LocalAgentScope(): React.JSX.Element {
  return <AgentSettingsView source={useLocalAgent()} />
}

function HostAgentScope(): React.JSX.Element {
  return <AgentSettingsView source={useHostAgent()} />
}
