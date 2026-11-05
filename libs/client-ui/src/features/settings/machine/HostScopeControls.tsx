import { useMemo } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { useHostSection } from './HostSection'
import { guardHostDrafts } from './machineSettingsDrafts'
import { ScopeRefresh } from './ScopeRefresh'
import { ScopeRow } from './ScopeRow'

/**
 * A Host's folders are its registered repositories, the active lane's first
 * when it runs on this Host; a change asks about an unsaved draft first.
 */
export function HostScopeRow(): React.JSX.Element {
  const { machine, connection, settings, starting } = useHostSection()
  const repositories = connection?.repositories
  const laneId = useSessionsStore((s) => {
    const live = s.activeSessionId ? s.live[s.activeSessionId] : undefined
    return live?.target?.kind === 'remote' && live.target.hostId === machine.id
      ? live.laneId
      : undefined
  })
  const preferred = connection?.lanes.find((lane) => lane.laneId === laneId)?.repositoryId
  const folders = useMemo(
    () => (repositories ?? []).map((repo) => ({ value: repo.id, label: repo.name })),
    [repositories],
  )
  return (
    <ScopeRow
      folders={folders}
      preferred={preferred}
      disabled={settings.saving || starting}
      guard={guardHostDrafts(machine.id)}
    />
  )
}

/** Reads the Host section again, once it can be read (its settings need the grant). */
export function HostRefresh(): React.JSX.Element | null {
  const { machine, settings, starting, readable, refresh } = useHostSection()
  if (!readable) return null
  return (
    <ScopeRefresh
      disabled={settings.loading || settings.saving || starting}
      onClick={() => guardHostDrafts(machine.id)(() => void refresh())}
      label={settings.loading ? 'Reading Host settings…' : 'Refresh'}
    />
  )
}
