import { catalogueModels } from './catalogue'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { pickTitleModel, titleAttempts, type TitleAttempt, type TitleModel } from './session-naming'

/** Learned only from successful title runs; owned for one app launch. */
export interface TitleMemory {
  fullBootProviders: Set<string>
  unusableTitleModels: Set<string>
}

export const modelKey = (model: TitleModel): string => `${model.provider}/${model.id}`

const sameModel = (a: TitleModel | null, b: TitleModel | null): boolean =>
  (a ? modelKey(a) : null) === (b ? modelKey(b) : null)

/**
 * Learn from the attempts that failed before `used` succeeded, so a setup
 * that cannot take the fast path pays for the failed run once per app launch,
 * not on every chat. Only learned from an eventual success: when everything
 * fails (offline, signed out) there is no telling what was at fault.
 */
export function rememberTitleFailures(
  memory: TitleMemory,
  failed: TitleAttempt[],
  used: TitleAttempt,
  defaultProvider: string | undefined,
): void {
  for (const attempt of failed) {
    if (attempt.extensions && !used.extensions && sameModel(attempt.model, used.model)) {
      memory.fullBootProviders.add(attempt.model?.provider ?? defaultProvider ?? '')
    }
    if (attempt.model && !sameModel(attempt.model, used.model)) {
      memory.unusableTitleModels.add(modelKey(attempt.model))
    }
  }
}

/** How long a title waits for a cold model catalogue before using the default. */
const CATALOGUE_WAIT_MS = 4_000

/**
 * Which model to title on, and whether a fast `-ne` boot is possible.
 *
 * The catalogue is preloaded at boot, so this is usually a cache hit. The
 * provider's own extension is loaded on a fast boot for the one extension
 * provider Phosphor knows (pi-claude-cli); any other provider gets a bare
 * `-ne`, and `titleAttempts` retries with a full boot if it was not built in.
 */
export async function planTitleRun(
  memory: TitleMemory,
  workspacePath: string,
  settings: { defaultProvider?: string; defaultModel?: string },
  fallback: TitleModel | null,
): Promise<TitleAttempt[]> {
  const catalogue = await Promise.race([
    catalogueModels().catch(() => []),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), CATALOGUE_WAIT_MS)),
  ])
  const picked = pickTitleModel(catalogue, settings.defaultProvider, settings.defaultModel)
  const model = picked && !memory.unusableTitleModels.has(modelKey(picked)) ? picked : fallback
  const provider = model?.provider ?? settings.defaultProvider ?? ''
  let fast: string[] | null = memory.fullBootProviders.has(provider) ? null : []
  if (fast && provider === 'pi-claude-cli') {
    const pkg = (await listPackages(workspacePath).catch(() => [])).find(
      (entry) => entry.name === '@saccolabs/pi-claude-cli' && entry.installed,
    )
    // Package resources are display names, not executable extension paths.
    const extensions = pkg?.installPath ? resolvePackagePaths(pkg.installPath).extensions : []
    fast = extensions.length ? extensions : null
  }
  return titleAttempts(model, fast, fallback)
}
