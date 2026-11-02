import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { piAgentDir, webSearchConfigPath } from './pi-paths'
import { type CatalogueModel } from './model-catalogue'
import { mergeAgentPatch, type PiAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { readJsonFile, type JsonFileRead } from '@phosphor/session-runtime/pi/json-config'
import {
  DESKTOP_FILE_POLICY,
  readSettingsBytes,
  saveSettingsFile,
  SettingsFailure,
  settingsFile,
  withSettingsFileLock,
  writeSettingsText,
  type SettingsFilePolicy,
} from '@phosphor/session-runtime/pi/settings-file'

/** One settings file, read with health — see `json-config.ts`. */
type ReadResult = JsonFileRead<PiAgentSettings>

const readJson = (path: string): Promise<ReadResult> => readJsonFile<PiAgentSettings>(path)

/**
 * Both scopes' settings, unmerged — for editors that must show what a file
 * actually contains rather than the effective merged view (a project
 * override displaying inherited global values would silently copy them into
 * `.pi/settings.json` on the next edit).
 */
export async function readAgentSettingsScoped(workspacePath?: string): Promise<{
  global: PiAgentSettings
  project: PiAgentSettings | null
}> {
  const global = await readJson(join(piAgentDir(), 'settings.json'))
  const project = workspacePath ? await readJson(join(workspacePath, '.pi', 'settings.json')) : null
  return { global: global.value, project: project ? project.value : null }
}

/** Read + report whether either scope's file is currently unparseable. */
export async function checkAgentSettings(
  workspacePath?: string,
): Promise<{ global: ReadResult; project: ReadResult | null }> {
  const global = await readJson(join(piAgentDir(), 'settings.json'))
  const project = workspacePath ? await readJson(join(workspacePath, '.pi', 'settings.json')) : null
  return { global, project }
}

export type EditableConfigFile = 'settings' | 'models' | 'web-search'

function configFilePath(name: EditableConfigFile): string {
  // web-search.json belongs to pi-web-access and lives in that package's
  // own config dir (default ~/.pi), not pi's agent dir.
  return name === 'web-search' ? webSearchConfigPath() : join(piAgentDir(), `${name}.json`)
}

/** Raw config file access for the raw editors. Never exposes auth.json. */
export async function readConfigFile(
  name: EditableConfigFile,
): Promise<{ path: string; content: string }> {
  const path = configFilePath(name)
  try {
    return { path, content: await readFile(path, 'utf8') }
  } catch {
    return { path, content: '' }
  }
}

export async function writeConfigFile(name: EditableConfigFile, content: string): Promise<void> {
  // Must be valid JSON — refuse to write broken config.
  JSON.parse(content)
  const path = configFilePath(name)
  await withSettingsFileLock(path, async () => {
    // The raw editor is how a malformed file gets fixed, so only its bytes are checked.
    const { revision } = readSettingsBytes(path, DESKTOP_FILE_POLICY)
    await writeSettingsText(path, content, revision, () => true, DESKTOP_FILE_POLICY)
  })
}

/**
 * Patch one pi config file through the shared writer, under its lock. A file
 * that is present but holds no JSON object is never overwritten: merging onto
 * a failed read would drop every key the user had.
 */
async function patchConfigFile(
  path: string,
  /** Completes "Phosphor will not overwrite it…". */
  fix: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
  policy: SettingsFilePolicy = DESKTOP_FILE_POLICY,
): Promise<void> {
  await withSettingsFileLock(path, async () => {
    let file: { raw: Record<string, unknown>; revision: string }
    try {
      file = settingsFile(path, policy)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const problem =
        error instanceof SettingsFailure && error.malformed ? 'is not valid JSON' : 'cannot be read'
      throw new Error(`${path} ${problem} (${reason}). Phosphor will not overwrite it${fix}`, {
        cause: error,
      })
    }
    await saveSettingsFile(path, update(file.raw), file.revision, () => true, policy)
  })
}

/**
 * pi-web-access config (web-search.json): read with health, and merge-patch
 * with the same malformed-file guard as settings.json — a patch onto a
 * failed parse would drop every key the user had.
 */
export async function readWebSearchConfig(): Promise<{
  path: string
  exists: boolean
  malformed: boolean
  error?: string
  config: Record<string, unknown>
}> {
  const path = webSearchConfigPath()
  const read = await readJson(path)
  return {
    path,
    exists: read.exists,
    malformed: read.malformed,
    error: read.error,
    config: read.value,
  }
}

export async function patchWebSearchConfig(patch: Record<string, unknown>): Promise<void> {
  await patchConfigFile(
    webSearchConfigPath(),
    ' — fix it via "Edit raw JSON" first.',
    (current) => ({
      ...current,
      ...patch,
    }),
  )
}

/**
 * Merge a patch into pi's settings.json (global or workspace override).
 *
 * Refuses to write when the existing file is present but unparseable: a
 * merge onto a failed read would drop every key the user already had
 * (defaultProvider, packages[], …). The caller surfaces the error and points
 * the user at the raw editor in Advanced.
 */
export async function patchAgentSettings(
  scope: 'global' | 'project',
  workspacePath: string | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  const dir = scope === 'global' ? piAgentDir() : join(workspacePath ?? '', '.pi')
  const fix =
    ' and lose your existing settings — fix it in Settings → Advanced → pi settings.json, then try again.'
  await patchConfigFile(join(dir, 'settings.json'), fix, (current) =>
    mergeAgentPatch(current, patch),
  )
}

/** One selectable model, as recorded in pi's models.json. */
export type { CatalogueModel } from './model-catalogue'

/**
 * models.json-only view: what the *user* declared in pi's config.
 *
 * This misses pi's built-in providers, so it is the fallback rather than the
 * primary source — see `resolveCatalogueModels()` in model-catalogue.ts, which
 * prefers `pi --list-models`. Kept separate so it stays hermetically testable
 * against a fixture models.json, with no dependency on a pi binary.
 *
 * `reasoning` comes from the provider's `compat.supportsReasoningEffort`,
 * defaulting to true, because models.json carries no per-model signal.
 */
export async function listCatalogueModels(): Promise<CatalogueModel[]> {
  const read = await readJson(join(piAgentDir(), 'models.json'))
  const providers = read.value.providers
  if (!providers || typeof providers !== 'object') return []

  const models: CatalogueModel[] = []
  for (const [provider, config] of Object.entries(providers as Record<string, unknown>)) {
    if (!config || typeof config !== 'object') continue
    const { models: list, compat } = config as {
      models?: unknown
      compat?: { supportsReasoningEffort?: boolean }
    }
    if (!Array.isArray(list)) continue
    const reasoning = compat?.supportsReasoningEffort !== false
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const { id, name, thinkingLevelMap } = entry as {
        id?: unknown
        name?: unknown
        thinkingLevelMap?: CatalogueModel['thinkingLevelMap']
      }
      if (typeof id !== 'string' || id.length === 0) continue
      models.push({
        id,
        name: typeof name === 'string' && name ? name : id,
        provider,
        reasoning,
        // Passed through when the user declared it in models.json, so the
        // home picker's level derivation stays per-model even on fallback.
        thinkingLevelMap: typeof thinkingLevelMap === 'object' ? thinkingLevelMap : undefined,
      })
    }
  }
  return models
}

/**
 * Local (non-package) pi resources for the read-only Advanced viewer:
 * loose files under `~/.pi/agent/{skills,extensions,prompts,themes}`.
 * Package-provided resources are shown per-package in the Extensions tab.
 */
export async function listPiResources(): Promise<{
  skills: string[]
  extensions: string[]
  prompts: string[]
  themes: string[]
}> {
  const base = piAgentDir()
  const list = async (sub: string): Promise<string[]> => {
    try {
      return (await readdir(join(base, sub))).filter((f) => !f.startsWith('.'))
    } catch {
      return []
    }
  }
  return {
    skills: await list('skills'),
    extensions: await list('extensions'),
    prompts: await list('prompts'),
    themes: await list('themes'),
  }
}
