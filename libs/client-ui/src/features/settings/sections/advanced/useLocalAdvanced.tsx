import { useState } from 'react'
import { piInstallLocation } from '@shared/models'
import { ConfigFileEditor, piConfigFile } from '../../ConfigFileEditor'
import { useSectionLoad } from '../sectionStatus'
import type { AdvancedSource } from './source'

const CAPS = { rawFiles: true, maintenance: true } as const

/** This Mac's pi health, PATH, raw editors, maintenance and loose resources. */
export function useLocalAdvanced(): AdvancedSource {
  const [editing, setEditing] = useState<'settings' | 'models' | null>(null)
  const { data, status } = useSectionLoad(() =>
    Promise.all([window.phosphor.invoke('pi:health'), window.phosphor.invoke('pi:listResources')]),
  )
  const [health, resources] = data ?? [null, null]
  return {
    status,
    notice: null,
    caps: CAPS,
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
