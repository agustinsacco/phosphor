import { join } from 'node:path'
import type { MachineSettings, MachineSettingsPatch } from '@phosphor/shared/machine-settings'
import { readMcpConfigs } from '@phosphor/session-runtime/pi/mcp-config'
import { validateHostConfig } from '../config/schema'
import type { SettingsContext } from './context'
import { saveSettingsFile, settingsFile, SettingsFailure, withSettingsFileLock } from './files'

export async function readAgentSettings(
  state: SettingsContext,
  cwd?: string,
): Promise<Pick<MachineSettings, 'agent' | 'projectTrusted'>> {
  const global = settingsFile(join(state.agentDir, 'settings.json')).raw
  const configs = await readMcpConfigs(cwd, state.dirs)
  // This is an editor: show saved folder values even before trust. Runtime
  // readAgentSettings separately excludes them until pi trusts the folder.
  const project = cwd ? settingsFile(join(cwd, '.pi', 'settings.json')).raw : {}
  const effective = { ...global, ...project }
  const host = validateHostConfig(settingsFile(state.options.configPath).raw)
  if (!host.ok)
    throw new SettingsFailure('bad-request', 'Host config is invalid. Nothing was overwritten.')
  return {
    ...(cwd ? { projectTrusted: configs.projectTrust?.trusted ?? false } : {}),
    agent: {
      ...(typeof effective.defaultProvider === 'string'
        ? { defaultProvider: effective.defaultProvider }
        : {}),
      ...(typeof effective.defaultModel === 'string'
        ? { defaultModel: effective.defaultModel }
        : {}),
      ...(typeof effective.defaultThinkingLevel === 'string'
        ? {
            defaultThinkingLevel: effective.defaultThinkingLevel as NonNullable<
              MachineSettings['agent']
            >['defaultThinkingLevel'],
          }
        : {}),
      contextBudget: host.config.contextBudget ?? '',
      autoNameLanes: host.config.autoNameLanes !== false,
    },
  }
}

export async function changeAgentSettings(
  state: SettingsContext,
  input: MachineSettingsPatch,
  patch: Extract<MachineSettingsPatch['change'], { type: 'agent.patch' }>['patch'],
  cwd: string | undefined,
  commitAllowed: () => boolean,
) {
  // Host policy fields cannot be mixed into a pi settings patch. Separate commits
  // avoid pretending a multi-file update is atomic.
  const policy = 'contextBudget' in patch || 'autoNameLanes' in patch
  if (
    policy &&
    Object.keys(patch).some((key) => key !== 'contextBudget' && key !== 'autoNameLanes')
  )
    throw new SettingsFailure('bad-request', 'Save Host policy separately from model defaults.')
  const path = policy
    ? state.options.configPath
    : cwd
      ? join(cwd, '.pi', 'settings.json')
      : join(state.agentDir, 'settings.json')
  await withSettingsFileLock(path, async () => {
    if (state.revision('agent', cwd) !== input.revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    const file = settingsFile(path)
    const next = { ...file.raw, ...patch }
    if (policy && !validateHostConfig(next).ok)
      throw new SettingsFailure('bad-request', 'Invalid Host policy.')
    await saveSettingsFile(path, next, file.revision, commitAllowed)
  })
}
