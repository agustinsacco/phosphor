import type { MachineAgentDefaults } from '@shared/machine-settings'
import type { MachineModel } from '@shared/host-protocol-machine'
import {
  AGENT_FIELDS,
  withAgentField,
  type AgentFieldKey,
  type MachineAgentBehavior,
} from '@shared/machine-agent-behavior'
import type { ThinkingLevel } from '@shared/rpc'
import { useEffect, useMemo, useState } from 'react'
import type { SaveState, SettingsNoticeProps } from '@/components/form'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { hostInstructions } from '../../instructions/instructionsSource'
import { useHostSection } from '../../machine/HostSection'
import { useMachineAgentDraft } from '../../machine/machineSettingsDrafts'
import { needsServiceRestart, type AgentPatch } from '../../machine/machineAgentPatch'
import type { AgentSource } from './source'

const ALL_FIELDS = Object.keys(AGENT_FIELDS) as AgentFieldKey[]
const THINKING_ONLY: AgentFieldKey[] = ['defaultThinkingLevel']

/** One "Saved" notice at a time: a run of edits replaces it rather than stacking cards. */
let savedToast = 0
function announceSave(
  label: string,
  patch: AgentPatch,
  saved: boolean,
  namingLive: true | undefined,
): void {
  const toasts = useExtensionUiStore.getState()
  if (savedToast) toasts.dismissToast(savedToast)
  savedToast = 0
  if (!saved) {
    toasts.pushToast(`Couldn’t save on ${label}. Your change is kept in Agent defaults.`, 'error')
    return
  }
  savedToast = toasts.pushToast(
    needsServiceRestart(patch, namingLive)
      ? `Saved on ${label} — applies after the Host service restarts`
      : `Saved on ${label} — applies to new lanes`,
    'info',
  )
}

/** The Host's catalogue, read for this page so a failure can be retried here. */
function useHostCatalogue(hostId: string): Pick<AgentSource, 'models' | 'catalogue'> {
  const [models, setModels] = useState<MachineModel[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setModels(null)
    setFailed(false)
    window.phosphor.invoke('hosts:models', hostId).then(
      (rows) => live && setModels(rows),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [hostId, attempt])
  const choices = useMemo(
    () =>
      models?.map((m) => ({
        value: JSON.stringify([m.provider, m.id]),
        label: `${m.name} · ${m.provider}`,
      })) ?? null,
    [models],
  )
  return failed
    ? { models: [], catalogue: { failed: true, retry: () => setAttempt((n) => n + 1) } }
    : { models: choices }
}

/** In folder scope, the machine's own values: what a folder inherits (a second read). */
function useMachineScopeAgent(
  hostId: string,
  repositoryId: string | undefined,
  revision: string | undefined,
): MachineAgentDefaults | null {
  const [agent, setAgent] = useState<MachineAgentDefaults | null>(null)
  useEffect(() => {
    setAgent(null)
    if (!repositoryId) return
    let live = true
    window.phosphor.invoke('hosts:settingsRead', hostId, 'agent').then(
      (read) => live && setAgent(read.agent ?? null),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [hostId, repositoryId, revision])
  return agent
}

const pair = (agent: MachineAgentDefaults | null): string =>
  agent?.defaultProvider && agent.defaultModel
    ? JSON.stringify([agent.defaultProvider, agent.defaultModel])
    : ''

function hostNotice(
  folder: boolean,
  data: {
    projectTrusted?: boolean
    agentBehaviorSupported?: boolean
    agent?: MachineAgentDefaults
  },
): SettingsNoticeProps | null {
  if (folder && data.projectTrusted === false)
    return {
      tone: 'warning',
      title: 'pi does not trust this folder on this Host.',
      body: 'Folder settings save, but do not apply until project trust is approved under Folders. The machine’s settings stay in force.',
    }
  const missing = [
    ...(data.agentBehaviorSupported
      ? []
      : ['Update this Host to configure compaction, retry and message delivery.']),
    ...(folder || data.agent?.agentDirectives
      ? []
      : ['Update this Host to edit its global instructions and directives.']),
  ]
  return missing.length
    ? { tone: 'info', title: 'Update this Host', body: missing.join(' ') }
    : null
}

type Draft = ReturnType<typeof useMachineAgentDraft>

/** The draft engine's state, in the words every section's save line uses. */
const draftSave = (draft: Draft, label: string): SaveState =>
  draft.stale
    ? {
        status: 'refused',
        message:
          'These settings changed on the Host while you were editing. Your unsaved changes are kept, but they cannot overwrite the newer revision.',
        discard: draft.discard,
      }
    : draft.unsaved
      ? {
          status: 'error',
          message: `Some changes are not saved on ${label}. They are kept here until you try again or discard them.`,
          retry: draft.retry,
          discard: draft.discard,
        }
      : { status: draft.saving ? 'saving' : 'idle' }

/** The Host's machine-wide policy; a Host that binds naming at boot says so. */
const hostPolicy = (draft: Draft, namingLive: true | undefined): AgentSource['policy'] => ({
  budget: draft.fields.budget,
  setBudget: (value) => draft.set('budget', value),
  autoName: draft.fields.naming,
  setAutoName: (on) => draft.set('naming', on),
  autoNameNote: namingLive
    ? undefined
    : 'On this Host it applies after its service restarts; saving never restarts it.',
})

/**
 * A Host's Agent section through its revisioned settings: every edit is a
 * draft the autosave engine sends one patch at a time (`machineSettingsDrafts`).
 * What the Host refuses stays as a draft until it is retried or discarded.
 */
export function useHostAgent(): AgentSource {
  const { machine, settings, repositoryId } = useHostSection()
  const data = settings.data
  const state = data?.agent
  const draft = useMachineAgentDraft(machine.id, repositoryId, settings, (patch, saved) =>
    announceSave(machine.label, patch, saved, data?.agent?.namingLive),
  )
  const { fields } = draft
  const inherited = useMachineScopeAgent(machine.id, repositoryId, data?.revision)
  const catalogue = useHostCatalogue(machine.id)
  const instructions = useMemo(
    () => hostInstructions(machine.id, machine.label),
    [machine.id, machine.label],
  )
  const busy = settings.loading || draft.stale
  const own = { ...fields.behavior, defaultThinkingLevel: fields.thinking || undefined }
  const hostContext = useMemo(
    () => ({ kind: 'host' as const, label: machine.label, os: 'host-os', repositories: [] }),
    [machine.label],
  )
  return {
    status: state ? 'ready' : 'loading',
    notice: data ? hostNotice(!!repositoryId, data) : null,
    caps: { clear: data?.agentClearSupported === true, folderDirectives: false },
    save: draftSave(draft, machine.label),
    folder: !!repositoryId,
    blocked: busy,
    fields: data?.agentBehaviorSupported ? ALL_FIELDS : THINKING_ONLY,
    own,
    inherited: repositoryId ? ((inherited ?? null) as Record<string, unknown> | null) : null,
    setField: (key, value) => {
      if (key === 'defaultThinkingLevel')
        return draft.set('thinking', (value ?? '') as ThinkingLevel | '')
      const behavior = withAgentField({ ...fields.behavior }, AGENT_FIELDS[key].path, value)
      draft.set('behavior', behavior as MachineAgentBehavior)
    },
    model: fields.model,
    inheritedModel: repositoryId ? pair(inherited) : '',
    setModel: (value) => draft.set('model', value),
    ...catalogue,
    policy: repositoryId ? null : hostPolicy(draft, state?.namingLive),
    directives:
      !repositoryId && state?.agentDirectives
        ? {
            value: fields.directives,
            set: (next) => draft.set('directives', next),
            disabled: busy,
            machine: hostContext,
          }
        : null,
    instructions: !repositoryId && state?.agentDirectives ? instructions : null,
  }
}
