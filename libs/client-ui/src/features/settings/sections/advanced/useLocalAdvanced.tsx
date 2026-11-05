import { useEffect, useState } from 'react'
import { piInstallLocation, type AboutInfo } from '@shared/models'
import { usePlatform } from '@/platform/Platform'
import { ConfigFileEditor, piConfigFile } from '../../ConfigFileEditor'
import { useSectionLoad } from '../sectionStatus'
import { useAppUpdate } from './MachineRuntimeRows'
import type { AdvancedSource, MachineRuntime } from './source'
import { useOnLocalRefresh } from '../../machine/ScopeRefresh'

const CAPS = { rawFiles: true, maintenance: true } as const

/**
 * This app's `app:about` (About and Advanced both read it here), while
 * `enabled`: null until it answers, "unknown" when it failed.
 */
export function useAboutInfo(enabled: boolean): AboutInfo | 'unknown' | null {
  const [about, setAbout] = useState<AboutInfo | 'unknown' | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    window.phosphor.invoke('app:about').then(
      (info) => live && setAbout(info),
      () => live && setAbout('unknown'),
    )
    return () => {
      live = false
    }
  }, [enabled])
  return about
}

/**
 * This Mac's Phosphor: its version and update, where the app reports them. A
 * failed version read keeps the update row and says "unknown".
 */
function useLocalRuntime(): MachineRuntime | undefined {
  const { appInfo } = usePlatform()
  const about = useAboutInfo(appInfo)
  const update = useAppUpdate(appInfo)
  if (!appInfo || !about) return undefined
  if (about === 'unknown') return { product: 'Phosphor', version: 'unknown', update }
  return { product: 'Phosphor', version: about.appVersion, platform: about.platform, update }
}

/** This Mac's version and update, pi health, PATH, raw editors, maintenance and loose resources. */
export function useLocalAdvanced(): AdvancedSource {
  const [editing, setEditing] = useState<'settings' | 'models' | null>(null)
  const { data, status, reload } = useSectionLoad(() =>
    Promise.all([window.phosphor.invoke('pi:health'), window.phosphor.invoke('pi:listResources')]),
  )
  useOnLocalRefresh(reload)
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
