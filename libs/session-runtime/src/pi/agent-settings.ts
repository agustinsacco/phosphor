import { join } from 'node:path'
import { readJsonFile, type JsonFileRead } from './json-config'
import { piAgentDir } from './pi-paths'
import { projectTrust } from './mcp-config'
import { SettingsFailure } from './settings-file'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'

/**
 * pi's effective settings for a workspace, read the way pi reads them, and the
 * one merge both machines' editors save with (`mergeAgentPatch`).
 */
export interface PiAgentSettings {
  hideThinkingBlock?: boolean
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  theme?: string
  [key: string]: unknown
}

/** One settings file, read with health; see `json-config.ts`. */
const readJson = (path: string): Promise<JsonFileRead<PiAgentSettings>> =>
  readJsonFile<PiAgentSettings>(path)

/**
 * Read pi's settings.json (global, merged with a trusted workspace override).
 * Unparseable files degrade to empty for display, but `malformed` is
 * reported so callers can refuse to write over them.
 *
 * Mirrors pi's own override semantics: nested objects merge one level deep
 * (a project `{compaction: {reserveTokens}}` keeps the global
 * `compaction.enabled`), everything else replaces.
 */
export async function readAgentSettings(
  workspacePath?: string,
  agentDir = piAgentDir(),
): Promise<PiAgentSettings> {
  const global = await readJson(join(agentDir, 'settings.json'))
  const trusted =
    workspacePath && (await projectTrust(workspacePath, { piAgent: agentDir })).trusted
  const project =
    workspacePath && trusted
      ? await readJson(join(workspacePath, '.pi', 'settings.json'))
      : { value: {}, exists: false, malformed: false }

  const merged: PiAgentSettings = { ...global.value, ...project.value }
  for (const [key, projectValue] of Object.entries(project.value)) {
    const globalValue = global.value[key]
    if (
      projectValue &&
      globalValue &&
      typeof projectValue === 'object' &&
      typeof globalValue === 'object' &&
      !Array.isArray(projectValue) &&
      !Array.isArray(globalValue)
    ) {
      merged[key] = { ...globalValue, ...projectValue }
    }
  }
  return merged
}

/** pi's settings groups an editor patches field by field. */
export const AGENT_NESTED_KEYS = ['compaction', 'retry'] as const

/**
 * Apply an editor's patch to a settings object, as Desktop and a Host both
 * save it. Top-level keys replace; each `nested` group merges one level deep,
 * so unknown fields inside it survive. `null` or `undefined` deletes a key or
 * a nested field (an emptied group goes too), so nothing is saved as `null`.
 * A nested group on disk that is not an object is refused rather than replaced.
 */
export function mergeAgentPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  nested: readonly string[] = AGENT_NESTED_KEYS,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete merged[key]
      continue
    }
    if (!nested.includes(key) || !machineRecord(value)) {
      merged[key] = value
      continue
    }
    const existing = current[key]
    if (existing !== undefined && !machineRecord(existing))
      throw new SettingsFailure('bad-request', `Invalid ${key} settings. Nothing was overwritten.`)
    const group: Record<string, unknown> = { ...existing }
    for (const [field, set] of Object.entries(value)) {
      if (set === null || set === undefined) delete group[field]
      else group[field] = set
    }
    if (Object.keys(group).length) merged[key] = group
    else delete merged[key]
  }
  return merged
}
