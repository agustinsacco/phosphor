import { useEffect, useRef, useState } from 'react'
import type { MachineAgentDefaults } from '@shared/machine-settings'
import { projectAgentBehavior } from '@shared/machine-agent-behavior'
import { promptChoice } from '@/stores/prompt'
import type { HostSettingsState } from './useHostSettings'
import {
  nextAgentPatch,
  rebaseAgentFields,
  type AgentDraftFields as Fields,
  type AgentPatch,
} from './machineAgentPatch'

type Draft = { revision: string; base: Fields; fields: Fields }
type Guard = {
  key: string
  hostId: string
  dirty: boolean
  busy: boolean
  /** Dirty, but autosave will send it on its own. */
  pending: boolean
  discard(): void
}
const drafts = new Map<string, Draft>()
let guard: Guard | undefined
const watchers = new Set<() => void>()
function publish(next: Guard | undefined): void {
  guard = next
  // Deferred: an effect's cleanup clears the guard just before its rerun sets
  // it again, and a waiter must see the commit's result, not that gap.
  if (watchers.size > 0) queueMicrotask(() => [...watchers].forEach((watch) => watch()))
}
/** Resolves once this Host's autosave is neither in flight nor queued, or after `ms`. */
function settled(hostId: string, ms = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(), ms)
    const done = () => {
      watchers.delete(check)
      clearTimeout(timer)
      resolve()
    }
    const check = () => {
      const current = guard
      if (!current || current.hostId !== hostId || !current.dirty) done()
      else if (!current.busy && !current.pending) done()
    }
    watchers.add(check)
    check()
  })
}
/** Leaving waits for a save in flight; only a change the Host refused asks to be discarded. */
export async function confirmSettingsNavigation(hostId: string): Promise<boolean> {
  await settled(hostId)
  const current = guard
  if (!current || current.hostId !== hostId || !current.dirty) return true
  if (current.busy || current.pending) return false
  if (
    (await promptChoice({
      title: 'Discard unsaved Host settings?',
      message:
        'Some changes were not saved on the Host. Stay here to try again, or discard this scope’s unsaved changes.',
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
/** Keeps a dirty draft for a remount and tells navigation what it is waiting on. */
function useDraftGuard(guarded: Omit<Guard, 'discard'>, draft: Draft, discard: () => void): void {
  const { key, hostId, dirty, busy, pending } = guarded
  useEffect(() => {
    if (dirty) {
      if (drafts.size >= 128 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!)
      drafts.set(key, draft)
    } else drafts.delete(key)
    const current = { key, hostId, dirty, busy, pending, discard }
    publish(current)
    return () => {
      if (guard === current) publish(undefined)
    }
    // discard closes over the current server snapshot.
  }, [key, draft, dirty, busy, pending])
}
/**
 * One agent patch at a time. `inflight` is state, not only the ref: it clears
 * in the same tick as the rebase, so no render sees the Host's new revision
 * beside a draft that has not adopted it yet.
 */
function useAgentSave(
  change: HostSettingsState['change'],
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
  setPaused: (paused: boolean) => void,
) {
  const [inflight, setInflight] = useState(false)
  const sending = useRef(false)
  async function save(patch: AgentPatch, sent: Fields): Promise<boolean> {
    if (sending.current) return false
    sending.current = true
    setInflight(true)
    try {
      const saved = await change({ type: 'agent.patch', patch })
      if (!saved?.agent) {
        // Paused in this tick too, or the next render would send it again.
        setPaused(true)
        return false
      }
      const base = fieldsFor(saved.agent)
      setDraft((current) => ({
        revision: saved.revision,
        base,
        fields: rebaseAgentFields(current.fields, sent, base, patch),
      }))
      return true
    } finally {
      sending.current = false
      setInflight(false)
    }
  }
  return { inflight, sending, save }
}
/** The latest callback, silenced once the component is gone. */
function useAnnouncer(announce?: (patch: AgentPatch, saved: boolean) => void) {
  const latest = useRef(announce)
  latest.current = announce
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return (patch: AgentPatch, saved: boolean) => {
    if (live.current) latest.current?.(patch, saved)
  }
}
/**
 * Every committed edit saves itself, one patch at a time against the latest
 * revision, as Desktop's settings do. What the Host refuses stays as a draft,
 * isolated by Host + folder, and survives a dropped connection. A draft
 * restored after a remount waits for an explicit save rather than sending on
 * its own, and a changed revision must be discarded before it can be saved.
 */
export function useMachineAgentDraft(
  hostId: string,
  repositoryId: string | undefined,
  settings: Pick<HostSettingsState, 'data' | 'saving' | 'change'>,
  announce?: (patch: AgentPatch, saved: boolean) => void,
) {
  const key = `${hostId}/${repositoryId ?? 'machine'}`
  const incoming = {
    revision: settings.data?.revision ?? '',
    base: fieldsFor(settings.data?.agent),
  }
  // A stored draft the Host already holds is a save that landed after the page
  // closed (closing does not wait for it), not an unsaved change.
  const [stored] = useState(() => {
    const kept = drafts.get(key)
    return kept && !same(kept.fields, incoming.base) ? kept : undefined
  })
  const [draft, setDraft] = useState<Draft>(() => stored ?? { ...incoming, fields: incoming.base })
  const [paused, setPaused] = useState(stored !== undefined)
  const saver = useAgentSave(settings.change, setDraft, setPaused)
  const announceNow = useAnnouncer(announce)
  const saving = settings.saving || saver.inflight
  const dirty = !same(draft.fields, draft.base)
  const stale = dirty && !saver.inflight && draft.revision !== incoming.revision
  const next = dirty && !stale ? nextAgentPatch(draft.fields, draft.base) : null
  const pending = next !== null && !paused
  const discard = () => {
    drafts.delete(key)
    setPaused(false)
    setDraft({ ...incoming, fields: incoming.base })
  }
  useEffect(() => {
    if (!dirty) setDraft({ ...incoming, fields: incoming.base })
    // A dirty draft deliberately keeps the revision it started from.
  }, [incoming.revision])
  useDraftGuard({ key, hostId, dirty, busy: saving, pending }, draft, discard)
  useEffect(() => {
    if (!pending || !next || saving || saver.sending.current) return
    void saver.save(next, draft.fields).then((ok) => announceNow(next, ok))
  })
  return {
    fields: draft.fields,
    base: draft.base,
    /** Records an edit; autosave sends it. */
    set<K extends keyof Fields>(field: K, value: Fields[K]) {
      setPaused(false)
      setDraft((current) => ({ ...current, fields: { ...current.fields, [field]: value } }))
    },
    /** Sends what the Host refused or a restored draft, on request. */
    retry: () => setPaused(false),
    stale,
    dirty,
    saving,
    /** Holds changes autosave will not send until the user asks. */
    unsaved: dirty && !stale && (paused || next === null),
    discard,
  }
}
