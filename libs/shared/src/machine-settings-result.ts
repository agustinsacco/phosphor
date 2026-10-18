import { machineRecord, parseMachineClaude, parseMachineProviders } from './host-protocol-machine'
import { isUuid } from './control-api'
import {
  isMachineAccountId,
  isMachinePackageSpec,
  MACHINE_SETTINGS_SECTIONS,
  type MachineSettings,
  type MachineAccount,
} from './machine-settings'
import type { ThinkingLevel } from './rpc'
const text = (v: unknown, max = 512): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
const list = (v: unknown, limit: number): v is unknown[] => Array.isArray(v) && v.length <= limit
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const optional = (v: unknown): v is string | undefined => v === undefined || text(v)
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
  if (value.section === 'providers') {
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
  if (value.section === 'connectors') {
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
  if (value.section === 'agent') {
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
      ...(typeof value.projectTrusted === 'boolean'
        ? { projectTrusted: value.projectTrusted }
        : {}),
      agent: {
        ...(a.defaultProvider ? { defaultProvider: a.defaultProvider } : {}),
        ...(a.defaultModel ? { defaultModel: a.defaultModel } : {}),
        ...(a.defaultThinkingLevel
          ? { defaultThinkingLevel: a.defaultThinkingLevel as ThinkingLevel }
          : {}),
        contextBudget: a.contextBudget,
        autoNameLanes: a.autoNameLanes,
      },
    }
  }
  if (value.section === 'resources') {
    const r = value.resources
    if (!machineRecord(r) || !list(r.packages, 256)) return null
    const packages: NonNullable<MachineSettings['resources']>['packages'] = []
    for (const p of r.packages) {
      if (
        !machineRecord(p) ||
        !text(p.spec, 512) ||
        !text(p.name) ||
        !optional(p.version) ||
        typeof p.installed !== 'boolean' ||
        !text(p.scope, 32)
      )
        return null
      packages.push({
        spec: isMachinePackageSpec(p.spec) ? p.spec : 'Source managed on Host',
        name: p.name,
        ...(p.version ? { version: p.version } : {}),
        installed: p.installed,
        scope: p.scope,
      })
    }
    return { ...base, resources: { packages } }
  }
  const a = value.advanced
  if (
    !machineRecord(a) ||
    !text(a.platform, 32) ||
    !text(a.hostVersion, 64) ||
    !text(a.configPath, 4096) ||
    !text(a.piAgentDir, 4096) ||
    !list(a.path, 128) ||
    !a.path.every((p) => text(p, 4096)) ||
    !list(a.environment, 64)
  )
    return null
  const environment: NonNullable<MachineSettings['advanced']>['environment'] = []
  for (const e of a.environment) {
    if (
      !machineRecord(e) ||
      !text(e.name, 128) ||
      typeof e.available !== 'boolean' ||
      typeof e.passed !== 'boolean'
    )
      return null
    environment.push({ name: e.name, available: e.available, passed: e.passed })
  }
  return {
    ...base,
    advanced: {
      platform: a.platform,
      hostVersion: a.hostVersion,
      configPath: a.configPath,
      piAgentDir: a.piAgentDir,
      path: a.path as string[],
      environment,
    },
  }
}
