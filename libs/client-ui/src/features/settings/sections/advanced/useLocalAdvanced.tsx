import { useEffect, useState } from 'react'
import { piInstallLocation, type AboutInfo } from '@shared/models'
import { usePlatform } from '@/platform/Platform'
import { ConfigFileEditor, piConfigFile } from '../../ConfigFileEditor'
import { useSectionLoad } from '../sectionStatus'
import { useAppUpdate } from './MachineRuntimeRows'
import type { AdvancedSource, MachineRuntime } from './source'

const CAPS = { rawFiles: true, maintenance: true } as const

/** This Mac's Phosphor: its version (`app:about`) and update, where the app reports them. */
function useLocalRuntime(): MachineRuntime | undefined {
  const { appInfo } = usePlatform()
  const [about, setAbout] = useState<AboutInfo | null>(null)
  useEffect(() => {
    if (!appInfo) return
    let live = true
    window.phosphor.invoke('app:about').then(
      (info) => live && setAbout(info),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [appInfo])
  const update = useAppUpdate(appInfo)
  if (!appInfo || !about) return undefined
  const platform = `${about.platform}-${about.arch}`
  return { product: 'Phosphor', version: about.appVersion, platform, update }
}

/** This Mac's version and update, pi health, PATH, raw editors, maintenance and loose resources. */
export function useLocalAdvanced(): AdvancedSource {
  const [editing, setEditing] = useState<'settings' | 'models' | null>(null)
  const { data, status } = useSectionLoad(() =>
    Promise.all([window.phosphor.invoke('pi:health'), window.phosphor.invoke('pi:listResources')]),
  )
  const [health, resources] = data ?? [null, null]
  const runtime = useLocalRuntime()
  return {
    status,
    notice: null,
    caps: CAPS,
    runtime,
    pi: health && {
      ok: health.ok,
      version: health.version,
      location: piInstallLocation(health) ?? 'not found',
      minVersion: health.minVersion,
      problem: health.reason ?? 'error',
    },
    agentDir: health?.agentDir,
    path: health?.path,
    resources,
    editFile: setEditing,
    dialog: editing && (
      <ConfigFileEditor source={piConfigFile(editing)} onClose={() => setEditing(null)} />
    ),
    footnote: 'auth.json is never read or displayed by Phosphor.',
  }
}
