import { meetsMinimum } from '../version'
import type { PiPackageEntry } from './platform'
import { MIN_CLAUDE_CONTEXT_VERSION } from './sessions'

/** The pi package that runs Claude sessions through the Claude Code CLI. */
export const CLAUDE_PROVIDER_PACKAGE = '@saccolabs/pi-claude-cli'

type ProviderCopy = Pick<PiPackageEntry, 'name' | 'version' | 'installed'>

/**
 * What keeps Claude sessions off these packages, or null when nothing does.
 * Before 0.9.0 the CLI loads its own context beside pi's, and on pi 0.86+ it
 * misses pi's prompt entirely, so the session would run without pi's
 * instructions or skills. Before 0.10.0 the thinking level the picker shows
 * is not what the model gets.
 */
export function claudeContextProviderShortfall(packages: readonly ProviderCopy[]): string | null {
  const providers = packages.filter((pkg) => pkg.name === CLAUDE_PROVIDER_PACKAGE)
  const unusable = providers.filter(
    (pkg) => !pkg.installed || !meetsMinimum(pkg.version, MIN_CLAUDE_CONTEXT_VERSION),
  )
  if (providers.length > 0 && unusable.length === 0) return null
  // Name what is there, so "I already updated it" has an answer: a stale
  // project-scope copy fails the check even beside a current global one.
  return providers.length === 0
    ? 'it is not installed'
    : unusable
        .map((pkg) =>
          pkg.installed ? `found ${pkg.version ?? 'no version'}` : 'it is listed but not installed',
        )
        .join('; ')
}

/**
 * A machine's Claude provider in the Machines page's terms, by the rule main
 * refuses a session on: usable, installed but refused, or not installed.
 */
export function claudeProviderState(
  packages: readonly ProviderCopy[],
): 'ok' | 'outdated' | 'missing' {
  if (claudeContextProviderShortfall(packages) === null) return 'ok'
  return packages.some((pkg) => pkg.name === CLAUDE_PROVIDER_PACKAGE && pkg.installed)
    ? 'outdated'
    : 'missing'
}
