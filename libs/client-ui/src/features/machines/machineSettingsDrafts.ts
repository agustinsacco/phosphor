import { useEffect, useState } from 'react'
import type { MachineAgentDefaults, MachineSettingsChange } from '@shared/machine-settings'
import type { ThinkingLevel } from '@shared/rpc'
import {
  AGENT_BEHAVIOR_KEYS,
  projectAgentBehavior,
  type MachineAgentBehavior,
} from '@shared/machine-agent-behavior'
import { promptChoice } from '@/stores/prompt'
import type { HostSettingsState } from './useHostSettings'

type Fields = {
  model: string
  thinking: ThinkingLevel
  budget: string
  naming: boolean
  behavior: MachineAgentBehavior
}
type Draft = { revision: string; base: Fields; fields: Fields }
const drafts = new Map<string, Draft>()
let guard:
  { key: string; hostId: string; dirty: boolean; busy: boolean; discard(): void } | undefined
export async function confirmSettingsNavigation(hostId: string): Promise<boolean> {
  const current = guard
  if (!current || current.hostId !== hostId || !current.dirty) return true
  if (current.busy) return false
  if (
    (await promptChoice({
      title: 'Discard unsaved Host settings?',
      message:
        'Your changes have not been sent to the Host. Stay here to review and save them, or discard this scope’s draft.',
      choices: [{ value: 'discard', label: 'Discard and continue', primary: true }],
    })) !== 'discard'
  )
    return false
  current.discard()
  return true
}
const fieldsFor = (state?: MachineAgentDefaults): Fields => ({
  model:
    state?.defaultProvider && state.defaultModel
      ? JSON.stringify([state.defaultProvider, state.defaultModel])
      : '',
  thinking: state?.defaultThinkingLevel ?? 'medium',
  budget: state?.contextBudget || '200k',
  naming: state?.autoNameLanes ?? true,
  behavior: projectAgentBehavior({ ...state }),
})
const same = (a: Fields, b: Fields) => JSON.stringify(a) === JSON.stringify(b)
/** Non-secret drafts are isolated by Host + folder and survive a dropped connection.
 * No offline queue: a changed revision must be discarded before it can be saved. */
export function useMachineAgentDraft(
  hostId: string,
  repositoryId: string | undefined,
  settings: Pick<HostSettingsState, 'data' | 'saving' | 'change'>,
) {
  const key = `${hostId}/${repositoryId ?? 'machine'}`
  const incoming = {
    revision: settings.data?.revision ?? '',
    base: fieldsFor(settings.data?.agent),
  }
  const [draft, setDraft] = useState<Draft>(
    () => drafts.get(key) ?? { ...incoming, fields: incoming.base },
  )
  const dirty = !same(draft.fields, draft.base)
  const stale = dirty && draft.revision !== incoming.revision
  const discard = () => {
    drafts.delete(key)
    setDraft({ ...incoming, fields: incoming.base })
  }
  useEffect(() => {
    if (!dirty) setDraft({ ...incoming, fields: incoming.base })
    // A dirty draft deliberately keeps the revision it started from.
  }, [incoming.revision])
  useEffect(() => {
    if (dirty) {
      if (drafts.size >= 128 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!)
      drafts.set(key, draft)
    } else drafts.delete(key)
    const current = { key, hostId, dirty, busy: settings.saving, discard }
    guard = current
    return () => {
      if (guard === current) guard = undefined
    }
    // discard closes over the current server snapshot.
  }, [key, draft, dirty, settings.saving])
  async function save(
    change: Extract<MachineSettingsChange, { type: 'agent.patch' }>,
  ): Promise<void> {
    if (stale) return
    const saved = await settings.change(change)
    if (!saved?.agent) return
    const base = fieldsFor(saved.agent)
    setDraft((current) => {
      const fields = { ...current.fields }
      if ('defaultProvider' in change.patch || 'defaultModel' in change.patch)
        fields.model = base.model
      if ('defaultThinkingLevel' in change.patch) fields.thinking = base.thinking
      if ('contextBudget' in change.patch) fields.budget = base.budget
      if ('autoNameLanes' in change.patch) fields.naming = base.naming
      if (AGENT_BEHAVIOR_KEYS.some((key) => key in change.patch)) fields.behavior = base.behavior
      return { revision: saved.revision, base, fields }
    })
  }
  return {
    fields: draft.fields,
    set<K extends keyof Fields>(key: K, value: Fields[K]) {
      setDraft((current) => ({ ...current, fields: { ...current.fields, [key]: value } }))
    },
    save,
    stale,
    dirty,
    discard,
  }
}
