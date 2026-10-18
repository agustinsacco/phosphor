import type { ClaudeRoutingMode, ClaudeUsageSnapshot } from './models'
import type { ThinkingLevel } from './rpc'
import { machineRecord, type MachineClaude, type MachineProvider } from './host-protocol-machine'
import { isUuid } from './control-api'
import { MCP_SERVER_NAME, isMcpExposure, type McpServerConfig } from './mcp'
import { isValidContextBudgetValue } from './context-budget'

export const MACHINE_SETTINGS_SECTIONS = [
  'providers',
  'connectors',
  'agent',
  'resources',
  'advanced',
] as const
export type MachineSettingsSection = (typeof MACHINE_SETTINGS_SECTIONS)[number]
export interface MachineAccount {
  id: string
  label: string
  email?: string
  plan?: string
  organization?: string
  loggedIn: boolean | null
  cooldownUntil: number | null
  usage: ClaudeUsageSnapshot | null
  lanes: { id: string; title: string; active: boolean }[]
}
export interface MachineAgentDefaults {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: ThinkingLevel
  contextBudget: string
  autoNameLanes: boolean
}
export type MachineSettings = {
  section: MachineSettingsSection
  revision: string
  /** Explicit Host-owned registered folder id, never a client path. */
  repositoryId?: string
  providers?: {
    providers: MachineProvider[]
    claude: MachineClaude
    accounts: MachineAccount[]
    mode: ClaudeRoutingMode
    pinnedId?: string
    authenticating: boolean
  }
  connectors?: {
    servers: {
      name: string
      scope: 'global' | 'project'
      transport: 'https' | 'stdio'
      enabled: boolean
      exposure: string
      state?: string
      tools?: number
    }[]
    checkedAt?: number
    inactiveNames?: string[]
    trusted: boolean | null
    legacy: boolean
    malformed: boolean
  }
  projectTrusted?: boolean
  agent?: MachineAgentDefaults
  resources?: {
    packages: { spec: string; name: string; version?: string; installed: boolean; scope: string }[]
  }
  advanced?: {
    platform: string
    hostVersion: string
    configPath: string
    piAgentDir: string
    path: string[]
    environment: { name: string; available: boolean; passed: boolean }[]
  }
}
export type MachineSettingsChange =
  | { type: 'claude.routing'; mode: ClaudeRoutingMode; pinnedId?: string }
  | { type: 'claude.remove'; accountId: string }
  | { type: 'claude.reorder'; ids: string[] }
  | { type: 'claude.refreshUsage' }
  | { type: 'claude.usage'; accountId: string }
  | { type: 'agent.patch'; patch: Partial<MachineAgentDefaults> }
  | { type: 'mcp.upsert'; name: string; config: McpServerConfig; approveCode?: true }
  | { type: 'mcp.remove'; name: string }
  | { type: 'mcp.enabled'; name: string; enabled: boolean }
export interface MachineSettingsPatch {
  section: MachineSettingsSection
  repositoryId?: string
  revision: string
  change: MachineSettingsChange
}
const text = (v: unknown, max = 300): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
export const isMachineAccountId = (v: unknown): v is string =>
  v === 'default' || (typeof v === 'string' && isUuid(v))
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
const repositoryId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v)
const boundedString = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
function privateHttpUrl(v: unknown): boolean {
  if (!text(v, 8192)) return false
  try {
    const url = new URL(v)
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  } catch {
    return false
  }
}
/** Reviewed settings only. No opaque options that might introduce another code path. */
function validMcpConfig(v: unknown): v is McpServerConfig {
  if (
    !machineRecord(v) ||
    !keys(v, [
      'type',
      'url',
      'headers',
      'oauth',
      'auth',
      'command',
      'args',
      'env',
      'cwd',
      'exposure',
      'toolExposure',
      'enabled',
      'description',
      'timeout',
    ])
  )
    return false
  const stdio = typeof v.command === 'string'
  if (
    stdio
      ? !text(v.command, 4096) ||
        /[\r\n]/.test(v.command) ||
        v.url !== undefined ||
        (v.type !== undefined && v.type !== 'stdio')
      : !privateHttpUrl(v.url) ||
        (v.type !== undefined && !['http', 'streamable-http'].includes(String(v.type)))
  )
    return false
  if (
    v.args !== undefined &&
    (!stdio ||
      !Array.isArray(v.args) ||
      v.args.length > 64 ||
      !v.args.every((arg) => boundedString(arg)))
  )
    return false
  if (v.cwd !== undefined && (!stdio || !text(v.cwd, 4096) || !v.cwd.startsWith('/'))) return false
  for (const key of ['headers', 'env'] as const) {
    const record = v[key]
    if (record === undefined) continue
    if (
      (key === 'env' && !stdio) ||
      !machineRecord(record) ||
      Object.keys(record).length > 64 ||
      !Object.entries(record).every(
        ([name, value]) =>
          (key === 'env'
            ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
            : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) &&
          boundedString(value) &&
          (key !== 'headers' || !/[\r\n]/.test(value)),
      )
    )
      return false
  }
  if (v.oauth !== undefined) {
    const oauth = v.oauth
    if (
      stdio ||
      !machineRecord(oauth) ||
      !keys(oauth, [
        'clientId',
        'clientSecret',
        'callbackPort',
        'callbackUrl',
        'scope',
        'clientName',
        'clientRegistration',
        'authServerMetadataUrl',
      ]) ||
      !Object.entries(oauth).every(([name, value]) =>
        name === 'callbackPort'
          ? Number.isInteger(value) && Number(value) > 0 && Number(value) < 65536
          : name === 'callbackUrl' || name === 'authServerMetadataUrl'
            ? privateHttpUrl(value)
            : name === 'clientRegistration'
              ? value === 'dcr' || value === 'cimd'
              : boundedString(value),
      )
    )
      return false
  }
  if (
    v.auth !== undefined &&
    (stdio || !machineRecord(v.auth) || !keys(v.auth, ['provider']) || !text(v.auth.provider, 100))
  )
    return false
  if (v.exposure !== undefined && !isMcpExposure(v.exposure)) return false
  if (
    v.toolExposure !== undefined &&
    (!machineRecord(v.toolExposure) ||
      Object.keys(v.toolExposure).length > 128 ||
      !Object.entries(v.toolExposure).every(
        ([name, exposure]) => text(name, 200) && isMcpExposure(exposure),
      ))
  )
    return false
  if (
    (v.enabled !== undefined && typeof v.enabled !== 'boolean') ||
    (v.description !== undefined && !boundedString(v.description, 2000)) ||
    (v.timeout !== undefined &&
      (typeof v.timeout !== 'number' ||
        !Number.isFinite(v.timeout) ||
        v.timeout <= 0 ||
        v.timeout > 300))
  )
    return false
  return JSON.stringify(v).length <= 32_000
}
export function parseSettingsRead(
  v: unknown,
): { section: MachineSettingsSection; repositoryId?: string } | null {
  if (
    !machineRecord(v) ||
    !keys(v, ['section', 'repositoryId']) ||
    !MACHINE_SETTINGS_SECTIONS.includes(v.section as MachineSettingsSection) ||
    (v.repositoryId !== undefined &&
      (!repositoryId(v.repositoryId) ||
        !['connectors', 'agent', 'resources'].includes(String(v.section))))
  )
    return null
  return {
    section: v.section as MachineSettingsSection,
    ...(v.repositoryId ? { repositoryId: v.repositoryId as string } : {}),
  }
}
export function parseSettingsPatch(v: unknown): MachineSettingsPatch | null {
  if (
    !machineRecord(v) ||
    !keys(v, ['section', 'repositoryId', 'revision', 'change']) ||
    !text(v.revision, 64) ||
    !/^[a-f0-9]{64}$/.test(v.revision) ||
    !machineRecord(v.change)
  )
    return null
  const read = parseSettingsRead({ section: v.section, repositoryId: v.repositoryId })
  if (!read) return null
  const c = v.change
  let valid = false
  switch (c.type) {
    case 'claude.routing':
      valid =
        read.section === 'providers' &&
        keys(c, ['type', 'mode', 'pinnedId']) &&
        ['specific', 'ordered', 'round-robin'].includes(String(c.mode)) &&
        (c.pinnedId === undefined || isMachineAccountId(c.pinnedId))
      break
    case 'claude.remove':
      valid =
        read.section === 'providers' &&
        keys(c, ['type', 'accountId']) &&
        isMachineAccountId(c.accountId)
      break
    case 'claude.reorder':
      valid =
        read.section === 'providers' &&
        keys(c, ['type', 'ids']) &&
        Array.isArray(c.ids) &&
        c.ids.length <= 16 &&
        c.ids.every(isMachineAccountId) &&
        new Set(c.ids).size === c.ids.length
      break
    case 'claude.usage':
      valid =
        read.section === 'providers' &&
        keys(c, ['type', 'accountId']) &&
        isMachineAccountId(c.accountId)
      break
    case 'claude.refreshUsage':
      valid = read.section === 'providers' && keys(c, ['type'])
      break
    case 'agent.patch': {
      if (
        read.section !== 'agent' ||
        !keys(c, ['type', 'patch']) ||
        !machineRecord(c.patch) ||
        !keys(c.patch, [
          'defaultProvider',
          'defaultModel',
          'defaultThinkingLevel',
          'contextBudget',
          'autoNameLanes',
        ])
      )
        break
      const p = c.patch
      valid = Object.entries(p).every(([key, value]) =>
        key === 'contextBudget'
          ? typeof value === 'string' && (value === '' || isValidContextBudgetValue(value))
          : key === 'autoNameLanes'
            ? typeof value === 'boolean'
            : key === 'defaultThinkingLevel'
              ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
              : text(value, 200),
      )
      if (read.repositoryId && ('contextBudget' in p || 'autoNameLanes' in p)) valid = false
      break
    }
    case 'mcp.remove':
      valid =
        read.section === 'connectors' &&
        keys(c, ['type', 'name']) &&
        typeof c.name === 'string' &&
        MCP_SERVER_NAME.test(c.name) &&
        c.name.length <= 64
      break
    case 'mcp.enabled':
      valid =
        read.section === 'connectors' &&
        keys(c, ['type', 'name', 'enabled']) &&
        typeof c.name === 'string' &&
        MCP_SERVER_NAME.test(c.name) &&
        c.name.length <= 64 &&
        typeof c.enabled === 'boolean'
      break
    case 'mcp.upsert':
      valid =
        read.section === 'connectors' &&
        keys(c, ['type', 'name', 'config', 'approveCode']) &&
        text(c.name, 64) &&
        MCP_SERVER_NAME.test(c.name) &&
        !c.name.startsWith('-') &&
        validMcpConfig(c.config) &&
        (!read.repositoryId ||
          (!c.config.headers && !c.config.env && !c.config.oauth?.clientSecret)) &&
        (c.approveCode === undefined || c.approveCode === true) &&
        (typeof c.config.command !== 'string' || c.approveCode === true)
      break
  }
  return valid
    ? { ...read, revision: v.revision, change: c as unknown as MachineSettingsChange }
    : null
}

export const MACHINE_TASKS = [
  'claude.installProvider',
  'claude.installCli',
  'package.install',
  'package.update',
  'package.remove',
  'mcp.login',
  'mcp.logout',
  'folder.trust',
] as const
export interface MachineTaskOp {
  type: 'machine.task'
  task: (typeof MACHINE_TASKS)[number]
  name?: string
  repositoryId?: string
}
/** The only package source syntax accepted by guided administration or read back to clients. */
export function isMachinePackageSpec(value: unknown): value is string {
  return (
    text(value, 256) &&
    /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^+-]+)?$/.test(value)
  )
}

export function parseMachineTask(v: unknown): MachineTaskOp | null {
  if (
    !machineRecord(v) ||
    !keys(v, ['type', 'task', 'name', 'repositoryId']) ||
    v.type !== 'machine.task' ||
    !MACHINE_TASKS.includes(v.task as MachineTaskOp['task']) ||
    (v.repositoryId !== undefined && !repositoryId(v.repositoryId))
  )
    return null
  const task = v.task as MachineTaskOp['task']
  if (task.startsWith('package.') && !isMachinePackageSpec(v.name)) return null
  if (
    task.startsWith('mcp.') &&
    (!text(v.name, 64) || !MCP_SERVER_NAME.test(v.name) || v.name.startsWith('-'))
  )
    return null
  if (task === 'folder.trust' && !v.repositoryId) return null
  if (v.repositoryId !== undefined && !task.startsWith('mcp.') && task !== 'folder.trust')
    return null
  if (v.name !== undefined && !task.startsWith('mcp.') && !task.startsWith('package.')) return null
  return {
    type: 'machine.task',
    task,
    ...(v.name ? { name: v.name as string } : {}),
    ...(v.repositoryId ? { repositoryId: v.repositoryId as string } : {}),
  }
}
