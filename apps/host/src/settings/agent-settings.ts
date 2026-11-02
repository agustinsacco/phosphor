import { join } from 'node:path'
import { projectAgentBehavior } from '@phosphor/shared/machine-agent-behavior'
import { normalizeAgentDirectives } from '@phosphor/shared/models'
import type { MachineSettings, MachineSettingsPatch } from '@phosphor/shared/machine-settings'
import { readMcpConfigs } from '@phosphor/session-runtime/pi/mcp-config'
import { AGENT_NESTED_KEYS, mergeAgentPatch } from '@phosphor/session-runtime/pi/agent-settings'
import { validateHostConfig } from '../config/schema'
import type { SettingsContext } from './context'
import {
  saveSettingsFile,
  settingsFile,
  SettingsFailure,
  withSettingsFileLock,
  HOST_FILE_POLICY,
} from '@phosphor/session-runtime/pi/settings-file'

export async function readAgentSettings(
  state: SettingsContext,
  cwd?: string,
): Promise<
  Pick<
    MachineSettings,
    'agent' | 'projectTrusted' | 'agentBehaviorSupported' | 'agentClearSupported'
  >
> {
  const global = settingsFile(join(state.agentDir, 'settings.json'), HOST_FILE_POLICY).raw
  const configs = await readMcpConfigs(cwd, state.dirs)
  // This is an editor: show saved folder values even before trust. Runtime
  // readAgentSettings separately excludes them until pi trusts the folder.
  const project = cwd ? settingsFile(join(cwd, '.pi', 'settings.json'), HOST_FILE_POLICY).raw : {}
  // Editors must never bake machine defaults into a folder's overrides.
  const effective = cwd ? project : global
  const host = validateHostConfig(settingsFile(state.options.configPath, HOST_FILE_POLICY).raw)
  if (!host.ok)
    throw new SettingsFailure('bad-request', 'Host config is invalid. Nothing was overwritten.')
  return {
    agentBehaviorSupported: true,
    agentClearSupported: true,
    ...(cwd ? { projectTrusted: configs.projectTrust?.trusted ?? false } : {}),
    agent: {
      ...projectAgentBehavior(effective),
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
      agentDirectives: normalizeAgentDirectives(host.config.agentDirectives),
    },
  }
}

/** Host config, not pi settings: they apply to the next lane started on this Host. */
const POLICY_KEYS = new Set(['contextBudget', 'autoNameLanes', 'agentDirectives'])

export async function changeAgentSettings(
  state: SettingsContext,
  input: MachineSettingsPatch,
  patch: Extract<MachineSettingsPatch['change'], { type: 'agent.patch' }>['patch'],
  cwd: string | undefined,
  commitAllowed: () => boolean,
) {
  // Host policy fields cannot be mixed into a pi settings patch. Separate commits
  // avoid pretending a multi-file update is atomic.
  const policy = Object.keys(patch).some((key) => POLICY_KEYS.has(key))
  if (policy && Object.keys(patch).some((key) => !POLICY_KEYS.has(key)))
    throw new SettingsFailure('bad-request', 'Save Host policy separately from model defaults.')
  const path = policy
    ? state.options.configPath
    : cwd
      ? join(cwd, '.pi', 'settings.json')
      : join(state.agentDir, 'settings.json')
  await withSettingsFileLock(path, async () => {
    if (state.revision('agent', cwd) !== input.revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    const file = settingsFile(path, HOST_FILE_POLICY)
    // Directive switches merge into the Host's own, as compaction/retry do into pi's.
    const next = mergeAgentPatch(file.raw, patch, policy ? ['agentDirectives'] : AGENT_NESTED_KEYS)
    if (policy && !validateHostConfig(next).ok)
      throw new SettingsFailure('bad-request', 'Invalid Host policy.')
    await saveSettingsFile(path, next, file.revision, commitAllowed, HOST_FILE_POLICY)
  })
}
