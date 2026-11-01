import type { MachineSettingsChange } from '@shared/machine-settings'
import { AGENT_BEHAVIOR_KEYS, type MachineAgentBehavior } from '@shared/machine-agent-behavior'
import type { ThinkingLevel } from '@shared/rpc'
import type { AgentDirectivePrefs } from '@shared/models'
import { machineAgentModel } from './machineAgentModel'

export type AgentDraftFields = {
  model: string
  thinking: ThinkingLevel
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
 * The next autosave for a draft: only fields that differ from what the Host
 * holds, or null when nothing savable differs. pi's settings go before Host
 * policy, because the Host refuses one patch that writes both files.
 */
export function nextAgentPatch(
  fields: AgentDraftFields,
  base: AgentDraftFields,
): AgentPatch | null {
  const pi: AgentPatch = {}
  const chosen = fields.model !== base.model ? machineAgentModel(fields.model) : null
  if (chosen) {
    pi.defaultProvider = chosen[0]
    pi.defaultModel = chosen[1]
  }
  if (fields.thinking !== base.thinking) pi.defaultThinkingLevel = fields.thinking
  for (const key of AGENT_BEHAVIOR_KEYS) {
    const value = fields.behavior[key]
    if (value !== undefined && !same(value, base.behavior[key])) Object.assign(pi, { [key]: value })
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
 * Host policy that only takes effect after a service restart. The directive
 * switches share its file but are read at each lane start.
 */
export const isPolicyPatch = (patch: AgentPatch): boolean =>
  'contextBudget' in patch || 'autoNameLanes' in patch
