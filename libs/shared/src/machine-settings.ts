import type { ClaudeRoutingMode, ClaudeUsageSnapshot } from './models'
import type { ThinkingLevel } from './rpc'
import type { MachineAgentBehavior } from './machine-agent-behavior'
import { machineRecord, type MachineClaude, type MachineProvider } from './host-protocol-machine'
import { MCP_SERVER_NAME, type McpServerConfig } from './mcp'
import { text, keys, repositoryId } from './machine-settings-fields'
import { validSettingsChange } from './machine-settings-change'
export { isMachineAccountId } from './machine-settings-fields'

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
export interface MachineAgentDefaults extends MachineAgentBehavior {
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
  agentBehaviorSupported?: boolean
  agent?: MachineAgentDefaults
  resources?: {
    packages: {
      spec: string
      name: string
      version?: string
      installed: boolean
      scope: string
      filtered?: boolean
      contents?: { extensions: number; skills: number; prompts: number; themes: number }
    }[]
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
  const valid = validSettingsChange(c, read)
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
  /** The Host's own signed `phosphor update`: no version, folder or argument from the caller. */
  'host.update',
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
