import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorText } from '@shared/errors'
import { AGENT_FIELDS, withAgentField, type AgentFieldKey } from '@shared/machine-agent-behavior'
import type { ConfigFileHealth } from '@shared/models'
import type { SettingsNoticeProps } from '@/components/form'
import { localMachineLabel } from '@/lib/localMachine'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { localInstructions } from '../../instructions/instructionsSource'
import { useSettingsUiStore } from '../../settingsUiStore'
import { useAccount } from '../../useAccount'
import { useLocalAgentPrefs } from './useLocalPrefs'
import type { SectionStatus } from '../sectionStatus'
import { modelChoices, type AgentSource, type AgentValues } from './source'

type Scoped = { global: AgentValues; project: AgentValues | null }
const ALL_FIELDS = Object.keys(AGENT_FIELDS) as AgentFieldKey[]
const pair = (values: AgentValues | null | undefined): string =>
  typeof values?.defaultProvider === 'string' && typeof values.defaultModel === 'string'
    ? JSON.stringify([values.defaultProvider, values.defaultModel])
    : ''

/** The settings.json keys `path` writes, nested groups one level deep, as main merges them. */
function patchFor(key: AgentFieldKey, value: unknown): AgentValues {
  const [group, field] = AGENT_FIELDS[key].path
  return field === undefined ? { [group]: value } : { [group]: { [field]: value } }
}

const malformedNotice = (folder: boolean, health: ConfigFileHealth): SettingsNoticeProps => ({
  tone: 'danger',
  title: `This ${folder ? 'folder' : 'machine'} settings.json is not valid JSON.`,
  body: `Editing is disabled so Phosphor cannot overwrite and lose your existing configuration. pi also ignores the broken file and falls back to its defaults.${health.error ? ` (${health.error})` : ''}`,
  action: {
    label: 'Fix it in Advanced →',
    onClick: () => useSettingsUiStore.getState().setTab('advanced'),
  },
})

/** pi trusts a folder before it reads the folder's settings; the MCP read reports it. */
function useFolderTrust(folder: string | null): string | null {
  const [untrusted, setUntrusted] = useState<string | null>(null)
  useEffect(() => {
    setUntrusted(null)
    if (!folder) return
    let live = true
    window.phosphor
      .invoke('mcp:readConfigs', folder)
      .then((configs) => {
        const trust = configs?.projectTrust
        if (live && trust && !trust.trusted) setUntrusted(trust.path)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [folder])
  return untrusted
}

/** This scope's settings.json, read unmerged beside the machine's, and written per edit. */
function useLocalSettingsFile(folder: string | null, loadPrefs: () => Promise<void>) {
  const [scoped, setScoped] = useState<Scoped | null>(null)
  const [health, setHealth] = useState<ConfigFileHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    const workspace = folder ?? undefined
    const [files, checked] = await Promise.all([
      window.phosphor.invoke('pi:agentSettingsScoped', workspace),
      window.phosphor.invoke('pi:checkAgentSettings', workspace),
      loadPrefs(),
    ])
    setScoped(files)
    setHealth(folder ? (checked.project ?? { exists: false, malformed: false }) : checked.global)
  }, [folder, loadPrefs])
  const read = useCallback((): void => {
    setError(null)
    load().catch((e: unknown) => setError(errorText(e)))
  }, [load])
  useEffect(() => read(), [read])
  /** Saves `patch`, then applies `apply` to this scope's values as they are by then. */
  const write = async (
    patch: AgentValues,
    apply: (values: AgentValues) => AgentValues,
  ): Promise<void> => {
    setSaving(true)
    try {
      const scope = folder ? 'project' : 'global'
      await window.phosphor.invoke('pi:patchAgentSettings', scope, folder ?? undefined, patch)
      setScoped(
        (s) =>
          s &&
          (folder ? { ...s, project: apply(s.project ?? {}) } : { ...s, global: apply(s.global) }),
      )
      useExtensionUiStore.getState().pushToast('Saved — applies to newly started sessions', 'info')
    } catch (e) {
      // A malformed file: main refuses to write rather than clobber it.
      useExtensionUiStore.getState().pushToast(errorText(e), 'error')
      read()
    } finally {
      setSaving(false)
    }
  }
  const own = (folder ? scoped?.project : scoped?.global) ?? {}
  return { scoped, health, error, saving, read, write, own }
}

function localNotice(
  folder: boolean,
  health: ConfigFileHealth | null,
  untrusted: string | null,
): SettingsNoticeProps | null {
  if (health?.malformed) return malformedNotice(folder, health)
  if (!untrusted) return null
  return {
    tone: 'warning',
    title: 'pi does not trust this folder.',
    body: `Folder settings save, but pi ignores them until you trust ${untrusted}: run pi once in a terminal there and choose Trust. The machine's settings stay in force.`,
  }
}

/**
 * This Mac's Agent section: pi's settings.json (the machine's, or the folder
 * chosen in the scope line), written as soon as a value changes, and
 * Phosphor's own prefs. Each scope is read unmerged, so a folder never
 * absorbs inherited machine values on its next write.
 */
export function useLocalAgent(): AgentSource {
  const folder = useSettingsUiStore((s) => s.folder)
  const prefs = useLocalAgentPrefs(folder)
  const file = useLocalSettingsFile(folder, prefs.load)
  const { scoped, own, write } = file
  const untrusted = useFolderTrust(folder)
  const catalogue = useLocalCatalogue()
  const { view } = useAccount()
  const machine = localMachineLabel()
  const instructions = useMemo(() => localInstructions(machine), [machine])
  const lanes = useLanePrefsStore((s) => s.lanes)
  const status: SectionStatus = file.error
    ? { error: file.error, retry: file.read }
    : scoped && prefs.prefs
      ? 'ready'
      : 'loading'
  return {
    status,
    notice: localNotice(!!folder, file.health, untrusted),
    caps: { clear: true, folderDirectives: true },
    save: { status: file.saving ? 'saving' : 'idle' },
    folder: !!folder,
    blocked: file.health?.malformed === true,
    fields: ALL_FIELDS,
    own,
    inherited: folder ? (scoped?.global ?? {}) : null,
    setField: (key, value) =>
      void write(patchFor(key, value), (values) =>
        withAgentField(values, AGENT_FIELDS[key].path, value),
      ),
    model: pair(own),
    inheritedModel: folder ? pair(scoped?.global) : '',
    setModel: (value) => {
      const [provider, model] = value ? (JSON.parse(value) as [string, string]) : []
      const patch = { defaultProvider: provider, defaultModel: model }
      void write(patch, (values) => ({ ...values, ...patch }))
    },
    ...catalogue,
    policy: folder
      ? null
      : {
          budget: prefs.budget,
          setBudget: prefs.setBudget,
          autoName: lanes.autoName,
          setAutoName: (on) => useLanePrefsStore.getState().setLanePrefs({ autoName: on }),
        },
    directives: prefs.directives
      ? {
          value: prefs.directives,
          set: prefs.setDirectives,
          override: prefs.override,
          machine: { kind: 'desktop', signedIn: view?.account.status === 'signed-in' },
          retired: folder ? undefined : { entries: prefs.retired, dismissed: prefs.reload },
        }
      : null,
    instructions: folder ? null : instructions,
  }
}

/** This Mac's model catalogue, shared with every session-less picker. */
function useLocalCatalogue(): Pick<AgentSource, 'models' | 'catalogue'> {
  const status = useModelCatalogueStore((s) => s.status)
  const models = useModelCatalogueStore((s) => s.models)
  useEffect(() => {
    void useModelCatalogueStore.getState().hydrate()
  }, [])
  const choices = useMemo(() => modelChoices(models), [models])
  if (status === 'error')
    return {
      models: choices,
      catalogue: { failed: true, retry: () => void useModelCatalogueStore.getState().refresh() },
    }
  return { models: status === 'ready' ? choices : null }
}
