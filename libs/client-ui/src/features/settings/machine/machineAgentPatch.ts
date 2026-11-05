import type { MachineSettingsChange } from '@shared/machine-settings'
import { AGENT_BEHAVIOR_KEYS, type MachineAgentBehavior } from '@shared/machine-agent-behavior'
import type { ThinkingLevel } from '@shared/rpc'
import type { AgentDirectivePrefs } from '@shared/models'
import { machineAgentModel } from './machineAgentModel'

export type AgentDraftFields = {
  /** `[provider, id]` as JSON; '' is none set, which clears a saved one. */
  model: string
  /** '' is none set: pi's default, or the machine's in folder scope. */
  thinking: ThinkingLevel | ''
  /** '' is the Host's default budget. */
  budget: string
  naming: boolean
  behavior: MachineAgentBehavior
  /** Host config, read at each lane start: no restart. */
  directives: AgentDirectivePrefs
}
export type AgentPatch = Extract<MachineSettingsChange, { type: 'agent.patch' }>['patch']

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const filled = (patch: AgentPatch): AgentPatch | null =>
  Object.keys(patch).length > 0 ? patch : null

/**
 * A behavior key's patch value: the draft's, with `null` for what it dropped
 * (Reset), since the Host merges nested groups one level deep.
 */
function behaviorPatch(value: unknown, prior: unknown): unknown {
  if (value === undefined) return null
  if (typeof value !== 'object' || typeof prior !== 'object' || prior === null) return value
  const group: Record<string, unknown> = { ...value }
  for (const field of Object.keys(prior)) if (!(field in group)) group[field] = null
  return group
}

/**
 * The next autosave for a draft: only fields that differ from what the Host
 * holds, or null when nothing savable differs. pi's settings go before Host
 * policy, because the Host refuses one patch that writes both files. A field
 * the draft cleared is sent as `null`, which only a Host whose read carries
 * `agentClearSupported` is offered.
 */
export function nextAgentPatch(
  fields: AgentDraftFields,
  base: AgentDraftFields,
): AgentPatch | null {
  const pi: AgentPatch = {}
  if (fields.model !== base.model) {
    const chosen = machineAgentModel(fields.model)
    if (chosen) [pi.defaultProvider, pi.defaultModel] = chosen
    else if (fields.model === '') pi.defaultProvider = pi.defaultModel = null
  }
  if (fields.thinking !== base.thinking) pi.defaultThinkingLevel = fields.thinking || null
  for (const key of AGENT_BEHAVIOR_KEYS) {
    const value = fields.behavior[key]
    if (!same(value, base.behavior[key]))
      Object.assign(pi, { [key]: behaviorPatch(value, base.behavior[key]) })
  }
  if (Object.keys(pi).length > 0) return pi
  const policy: AgentPatch = {}
  if (fields.budget.trim() !== base.budget) policy.contextBudget = fields.budget.trim()
  if (fields.naming !== base.naming) policy.autoNameLanes = fields.naming
  if (!same(fields.directives, base.directives)) policy.agentDirectives = fields.directives
  return filled(policy)
}

/**
 * After a save, adopt the Host's normalized value for each field it
 * acknowledged, unless the field was edited again while the save was in
 * flight: that newer edit stays dirty and becomes the next autosave.
 */
export function rebaseAgentFields(
  current: AgentDraftFields,
  sent: AgentDraftFields,
  base: AgentDraftFields,
  patch: AgentPatch,
): AgentDraftFields {
  const adopt = <K extends keyof AgentDraftFields>(key: K, acknowledged: boolean) =>
    acknowledged && same(current[key], sent[key]) ? base[key] : current[key]
  const behavior = { ...current.behavior }
  for (const key of AGENT_BEHAVIOR_KEYS) {
    if (key in patch && same(current.behavior[key], sent.behavior[key]))
      Object.assign(behavior, { [key]: base.behavior[key] })
  }
  return {
    model: adopt('model', 'defaultProvider' in patch || 'defaultModel' in patch),
    thinking: adopt('thinking', 'defaultThinkingLevel' in patch),
    budget: adopt('budget', 'contextBudget' in patch),
    naming: adopt('naming', 'autoNameLanes' in patch),
    behavior,
    // After behavior: drafts compare fields as JSON, so the order is fieldsFor's.
    directives: adopt('directives', 'agentDirectives' in patch),
  }
}

/**
 * Host policy that only takes effect after a service restart: automatic
 * naming on a Host whose read lacks `namingLive` (it binds the switch at boot).
 * The context budget and directive switches are read at each lane start.
 */
export const needsServiceRestart = (patch: AgentPatch, namingLive: true | undefined): boolean =>
  !namingLive && 'autoNameLanes' in patch
