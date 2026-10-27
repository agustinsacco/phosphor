import { machineRecord } from './host-protocol-machine'
import { MCP_SERVER_NAME } from './mcp'
import { isValidContextBudgetValue } from './context-budget'
import { text, keys, isMachineAccountId } from './machine-settings-fields'
import { validMcpConfig } from './machine-settings-mcp'
import type { MachineSettingsPatch } from './machine-settings'
import { AGENT_BEHAVIOR_KEYS, validAgentBehavior } from './machine-agent-behavior'

type Scope = Pick<MachineSettingsPatch, 'section' | 'repositoryId'>

function validClaudeChange(c: Record<string, unknown>, read: Scope): boolean {
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
  }
  return valid
}

function validAgentPatch(c: Record<string, unknown>, read: Scope): boolean {
  if (
    c.type !== 'agent.patch' ||
    read.section !== 'agent' ||
    !keys(c, ['type', 'patch']) ||
    !machineRecord(c.patch) ||
    !keys(c.patch, [
      'defaultProvider',
      'defaultModel',
      'defaultThinkingLevel',
      'contextBudget',
      'autoNameLanes',
      ...AGENT_BEHAVIOR_KEYS,
    ])
  )
    return false
  const p = c.patch
  const valid = Object.entries(p).every(([key, value]) =>
    AGENT_BEHAVIOR_KEYS.includes(key as (typeof AGENT_BEHAVIOR_KEYS)[number])
      ? validAgentBehavior(key, value)
      : key === 'contextBudget'
        ? typeof value === 'string' && (value === '' || isValidContextBudgetValue(value))
        : key === 'autoNameLanes'
          ? typeof value === 'boolean'
          : key === 'defaultThinkingLevel'
            ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
            : text(value, 200),
  )
  return valid && !(read.repositoryId && ('contextBudget' in p || 'autoNameLanes' in p))
}

function validConnectorChange(c: Record<string, unknown>, read: Scope): boolean {
  let valid = false
  switch (c.type) {
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
}

export function validSettingsChange(c: Record<string, unknown>, read: Scope): boolean {
  return validClaudeChange(c, read) || validAgentPatch(c, read) || validConnectorChange(c, read)
}
