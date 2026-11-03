import { createContext, useContext, useEffect, useState } from 'react'
import type { MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import type { MachineSettingsSection } from '@shared/machine-settings'
import { useSettingsUiStore } from '../settingsUiStore'
import { HostProgramDialog } from './HostProgramDialog'
import { useHostSettings } from './useHostSettings'
import { useMachinePrograms } from './useMachinePrograms'
import { confirmSettingsAccess } from './settingsAccess'

/** The Host settings section a Settings section reads; Folders reads `advanced`. */
export type MachineSettingsTab = MachineSettingsSection | 'folders'

/**
 * Everything a Host section needs: the machine, its settings read for this
 * section and folder scope, its private programs and the configuration grant.
 * `repositoryId` is the Settings folder scope on a scoped section.
 */
function useHostSectionState(
  machine: Pick<MachineView, 'id' | 'label'>,
  section: MachineSettingsTab,
  scoped: boolean,
) {
  const folder = useSettingsUiStore((s) => s.folder)
  const repositoryId = scoped ? (folder ?? undefined) : undefined
  const settings = useHostSettings(
    machine.id,
    section === 'folders' ? 'advanced' : section,
    repositoryId,
  )
  const { connection, allowed } = settings
  const programs = useMachinePrograms(machine, settings)
  const { setError, alive } = programs
  // An error belongs to the section and folder it happened in; a running program stays open.
  useEffect(() => setError(null), [section, repositoryId, setError])
  const [accessBusy, setAccessBusy] = useState(false)
  async function access() {
    if (!(await confirmSettingsAccess(machine.label)) || !alive.current) return
    setAccessBusy(true)
    setError(null)
    try {
      await window.phosphor.invoke('hosts:settingsAccess', machine.id)
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setAccessBusy(false)
    }
  }
  return {
    machine,
    section,
    repositoryId,
    scoped,
    settings,
    connection,
    allowed,
    ...programs,
    accessBusy,
    access,
  }
}
export type HostSection = ReturnType<typeof useHostSectionState>

const HostSectionContext = createContext<HostSection | null>(null)

/**
 * One Host section's state for the scope line, the gate and the view below
 * it. Also owns the private-program dialog (sign-ins, reviewed tasks), which
 * refreshes the section when it closes or its program exits.
 */
export function HostSectionProvider({
  machine,
  section,
  scoped,
  children,
}: {
  machine: Pick<MachineView, 'id' | 'label'>
  section: MachineSettingsTab
  scoped: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const host = useHostSectionState(machine, section, scoped)
  const { program, setProgram, settings } = host
  return (
    <HostSectionContext.Provider value={host}>
      {children}
      {program && (
        <HostProgramDialog
          hostLabel={machine.label}
          {...program}
          onClose={() => {
            setProgram(null)
            void settings.refresh()
          }}
          onSettled={() => void settings.refresh()}
        />
      )}
    </HostSectionContext.Provider>
  )
}

/** The enclosing Host section. Only Host entries of the section registry render under one. */
export function useHostSection(): HostSection {
  const host = useContext(HostSectionContext)
  if (!host) throw new Error('useHostSection outside HostSectionProvider')
  return host
}
