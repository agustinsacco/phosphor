import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { piAgentDir, webSearchConfigPath } from './pi-paths'
import { type CatalogueModel } from './model-catalogue'
import { readJsonFile, type JsonFileRead } from './json-config'

export interface PiAgentSettings {
  hideThinkingBlock?: boolean
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  theme?: string
  [key: string]: unknown
}

/** One settings file, read with health — see `json-config.ts`. */
type ReadResult = JsonFileRead<PiAgentSettings>

const readJson = (path: string): Promise<ReadResult> => readJsonFile<PiAgentSettings>(path)

/**
 * Read pi's settings.json (global, merged with the workspace override).
 * Unparseable files degrade to empty for display, but `malformed` is
 * reported so callers can refuse to write over them.
 *
 * Mirrors pi's own override semantics: nested objects merge one level deep
 * (a project `{compaction: {reserveTokens}}` keeps the global
 * `compaction.enabled`), everything else replaces.
 */
export async function readAgentSettings(workspacePath?: string): Promise<PiAgentSettings> {
  const global = await readJson(join(piAgentDir(), 'settings.json'))
  const project = workspacePath
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
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
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
  const path = webSearchConfigPath()
  const read = await readJson(path)
  if (read.malformed) {
    throw new Error(
      `${path} is not valid JSON (${read.error ?? 'parse error'}). ` +
        'Phosphor will not overwrite it — fix it via "Edit raw JSON" first.',
    )
  }
  const merged = { ...read.value, ...patch }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
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
  const path = join(dir, 'settings.json')
  const read = await readJson(path)

  if (read.malformed) {
    throw new Error(
      `${path} is not valid JSON (${read.error ?? 'parse error'}). ` +
        'Phosphor will not overwrite it and lose your existing settings — ' +
        'fix it in Settings → Advanced → pi settings.json, then try again.',
    )
  }

  const current = read.value
  const merged: Record<string, unknown> = { ...current, ...patch }
  // Nested objects (compaction/retry) merge one level deep.
  for (const key of ['compaction', 'retry'] as const) {
    if (
      patch[key] &&
      typeof patch[key] === 'object' &&
      current[key] &&
      typeof current[key] === 'object'
    ) {
      merged[key] = { ...(current[key] as object), ...(patch[key] as object) }
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
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
