import { machineRecord, parseMachineClaude, parseMachineProviders } from './host-protocol-machine'
import { isUuid } from './control-api'
import {
  isMachineAccountId,
  MACHINE_SETTINGS_SECTIONS,
  type MachineSettings,
  type MachineAccount,
} from './machine-settings'
import type { ThinkingLevel } from './rpc'
import { projectAgentBehavior } from './machine-agent-behavior'
import { normalizeAgentDirectives } from './models/directives'
import { parseGlobalInstructions } from './global-instructions'
import {
  list,
  number,
  optional,
  parseAdvanced,
  parseResources,
  text,
} from './machine-settings-result-sections'
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function account(v: unknown): MachineAccount | null {
  if (
    !machineRecord(v) ||
    !isMachineAccountId(v.id) ||
    !text(v.label) ||
    !optional(v.email) ||
    !optional(v.plan) ||
    !optional(v.organization) ||
    ![true, false, null].includes(v.loggedIn as boolean | null) ||
    !(v.cooldownUntil === null || number(v.cooldownUntil)) ||
    !list(v.lanes, 500)
  )
    return null
  const lanes: MachineAccount['lanes'] = []
  for (const lane of v.lanes) {
    if (
      !machineRecord(lane) ||
      typeof lane.id !== 'string' ||
      !isUuid(lane.id) ||
      !text(lane.title, 1000) ||
      typeof lane.active !== 'boolean'
    )
      return null
    lanes.push({ id: lane.id, title: lane.title, active: lane.active })
  }
  let usage: MachineAccount['usage'] = null
  if (v.usage !== null) {
    const u = v.usage
    if (
      !machineRecord(u) ||
      !number(u.fetchedAt) ||
      typeof u.stale !== 'boolean' ||
      !list(u.windows, 16)
    )
      return null
    const windows: NonNullable<MachineAccount['usage']>['windows'] = []
    for (const w of u.windows) {
      if (
        !machineRecord(w) ||
        !text(w.label) ||
        !['five_hour', 'weekly', 'weekly_model', 'other'].includes(String(w.kind)) ||
        !number(w.percentUsed) ||
        w.percentUsed > 200 ||
        !(w.resetsAt === null || number(w.resetsAt))
      )
        return null
      windows.push({
        label: w.label,
        kind: w.kind as (typeof windows)[number]['kind'],
        percentUsed: w.percentUsed,
        resetsAt: w.resetsAt,
      })
    }
    usage = { fetchedAt: u.fetchedAt, stale: u.stale, windows, contributing: null }
  }
  return {
    id: v.id,
    label: v.label,
    ...(v.email ? { email: v.email } : {}),
    ...(v.plan ? { plan: v.plan } : {}),
    ...(v.organization ? { organization: v.organization } : {}),
    loggedIn: v.loggedIn as boolean | null,
    cooldownUntil: v.cooldownUntil,
    usage,
    lanes,
  }
}
/** Only reviewed fields cross main's IPC boundary. Private paths/bindings/credentials never do. */
export function parseMachineSettings(value: unknown): MachineSettings | null {
  if (
    !machineRecord(value) ||
    !MACHINE_SETTINGS_SECTIONS.includes(value.section as MachineSettings['section']) ||
    !text(value.revision, 64) ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    (value.repositoryId !== undefined &&
      (typeof value.repositoryId !== 'string' || !/^[a-f0-9]{16}$/.test(value.repositoryId)))
  )
    return null
  const base: MachineSettings = {
    section: value.section as MachineSettings['section'],
    revision: value.revision,
    ...(value.repositoryId ? { repositoryId: value.repositoryId as string } : {}),
  }
  switch (value.section) {
    case 'providers':
      return parseProviders(value, base)
    case 'connectors':
      return parseConnectors(value, base)
    case 'agent':
      return parseAgent(value, base)
    case 'resources':
      return parseResources(value, base)
    case 'instructions':
      return parseInstructions(value, base)
    default:
      return parseAdvanced(value, base)
  }
}
function parseProviders(
  value: Record<string, unknown>,
  base: MachineSettings,
): MachineSettings | null {
  const p = value.providers
  if (
    !machineRecord(p) ||
    !list(p.accounts, 16) ||
    !['specific', 'ordered', 'round-robin'].includes(String(p.mode)) ||
    (p.pinnedId !== undefined && !isMachineAccountId(p.pinnedId)) ||
    typeof p.authenticating !== 'boolean'
  )
    return null
  const providers = parseMachineProviders(p.providers),
    claude = parseMachineClaude(p.claude)
  const accounts = p.accounts.map(account)
  if (!providers || !claude || accounts.some((a) => a === null)) return null
  return {
    ...base,
    providers: {
      providers,
      claude,
      accounts: accounts as MachineAccount[],
      mode: p.mode as 'specific' | 'ordered' | 'round-robin',
      ...(p.pinnedId ? { pinnedId: p.pinnedId as string } : {}),
      authenticating: p.authenticating,
    },
  }
}
function parseConnectors(
  value: Record<string, unknown>,
  base: MachineSettings,
): MachineSettings | null {
  const c = value.connectors
  if (
    !machineRecord(c) ||
    !list(c.servers, 128) ||
    !(c.trusted === null || typeof c.trusted === 'boolean') ||
    typeof c.legacy !== 'boolean' ||
    typeof c.malformed !== 'boolean'
  )
    return null
  const servers: NonNullable<MachineSettings['connectors']>['servers'] = []
  for (const s of c.servers) {
    if (
      !machineRecord(s) ||
      !text(s.name, 64) ||
      !['global', 'project'].includes(String(s.scope)) ||
      !['https', 'stdio'].includes(String(s.transport)) ||
      typeof s.enabled !== 'boolean' ||
      !text(s.exposure, 32)
    )
      return null
    servers.push({
      name: s.name,
      scope: s.scope as 'global' | 'project',
      transport: s.transport as 'https' | 'stdio',
      enabled: s.enabled,
      exposure: s.exposure,
      ...(typeof s.state === 'string' &&
      [
        'connected',
        'needs-auth',
        'failed',
        'disconnected',
        'connecting',
        'closed',
        'disabled',
      ].includes(s.state)
        ? { state: s.state }
        : {}),
      ...(number(s.tools) && s.tools <= 10000 ? { tools: s.tools } : {}),
      ...(typeof s.oauth === 'boolean' ? { oauth: s.oauth } : {}),
      ...(s.overridden === true ? { overridden: true as const } : {}),
    })
  }
  return {
    ...base,
    connectors: {
      servers,
      trusted: c.trusted,
      legacy: c.legacy,
      malformed: c.malformed,
      ...(number(c.checkedAt) ? { checkedAt: c.checkedAt } : {}),
      ...(Array.isArray(c.inactiveNames) &&
      c.inactiveNames.length <= 128 &&
      c.inactiveNames.every((name) => text(name, 64))
        ? { inactiveNames: c.inactiveNames as string[] }
        : {}),
    },
  }
}
function parseAgent(value: Record<string, unknown>, base: MachineSettings): MachineSettings | null {
  const a = value.agent
  if (
    !machineRecord(a) ||
    !optional(a.defaultProvider) ||
    !optional(a.defaultModel) ||
    (a.defaultThinkingLevel !== undefined && !levels.includes(String(a.defaultThinkingLevel))) ||
    !text(a.contextBudget, 32) ||
    typeof a.autoNameLanes !== 'boolean'
  )
    return null
  return {
    ...base,
    ...(typeof value.projectTrusted === 'boolean' ? { projectTrusted: value.projectTrusted } : {}),
    ...(value.agentBehaviorSupported === true ? { agentBehaviorSupported: true } : {}),
    ...(value.agentClearSupported === true ? { agentClearSupported: true as const } : {}),
    agent: {
      ...projectAgentBehavior(a),
      ...(a.defaultProvider ? { defaultProvider: a.defaultProvider } : {}),
      ...(a.defaultModel ? { defaultModel: a.defaultModel } : {}),
      ...(a.defaultThinkingLevel
        ? { defaultThinkingLevel: a.defaultThinkingLevel as ThinkingLevel }
        : {}),
      contextBudget: a.contextBudget,
      autoNameLanes: a.autoNameLanes,
      ...(a.namingLive === true ? { namingLive: true } : {}),
      ...(machineRecord(a.agentDirectives)
        ? { agentDirectives: normalizeAgentDirectives(a.agentDirectives) }
        : {}),
    },
  }
}
/** The file's own revision is the section's: a save is checked against the bytes that were read. */
function parseInstructions(
  value: Record<string, unknown>,
  base: MachineSettings,
): MachineSettings | null {
  const instructions = parseGlobalInstructions(value.instructions)
  if (!instructions || base.repositoryId || instructions.revision !== base.revision) return null
  return { ...base, instructions }
}
