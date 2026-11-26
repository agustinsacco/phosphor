import { normalizeAgentDirectives, type AgentDirectivePrefs } from '@phosphor/shared/models'
import {
  HOST_FILE_POLICY,
  settingsFile,
  saveSettingsFile,
  withSettingsFileLock,
  SettingsFailure,
} from '@phosphor/session-runtime/pi/settings-file'
import { validateHostConfig } from '../config/schema'
import type { SettingsContext } from './context'

export function setFolderDirective(
  state: SettingsContext,
  id: string,
  key: keyof AgentDirectivePrefs,
  on: boolean,
  authorized: () => boolean,
) {
  const path = state.options.configPath
  return withSettingsFileLock(path, async () => {
    const cwd = state.workspace(id)!
    const file = settingsFile(path, HOST_FILE_POLICY)
    const validated = validateHostConfig(file.raw)
    if (!validated.ok) throw new SettingsFailure('bad-request', 'Invalid Host config.')
    const { agentDirectives, agentDirectivesByProject } = validated.config
    const prefs = normalizeAgentDirectives(agentDirectivesByProject?.[cwd] ?? agentDirectives)
    const next = {
      ...file.raw,
      agentDirectivesByProject: { ...agentDirectivesByProject, [cwd]: { ...prefs, [key]: on } },
    }
    await saveSettingsFile(
      path,
      next,
      file.revision,
      () => authorized() && state.workspace(id) === cwd,
      HOST_FILE_POLICY,
    )
    state.options.changed?.({ kind: 'settings', repositoryId: id })
    return cwd
  })
}

/** The saved override is distinct from effective defaults shown by the settings editor. */
export function readDirectiveOverrides(state: SettingsContext, id?: string) {
  const cwd = id && state.workspace(id)
  if (id && !cwd) throw new SettingsFailure('bad-request', 'Unknown folder.')
  const file = settingsFile(state.options.configPath, HOST_FILE_POLICY)
  const validated = validateHostConfig(file.raw)
  if (!validated.ok) throw new SettingsFailure('bad-request', 'Invalid Host config.')
  const { agentDirectives, agentDirectivesByProject } = validated.config
  return {
    global: agentDirectives,
    project: cwd ? (agentDirectivesByProject?.[cwd] ?? null) : undefined,
  }
}
