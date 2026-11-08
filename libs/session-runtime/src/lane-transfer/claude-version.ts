import { CLAUDE_PROVIDER_PACKAGE } from '@phosphor/shared/models'
import { meetsMinimum } from '@phosphor/shared/version'
import { listPackages } from '../pi/packages'
import { piAgentDir } from '../pi/pi-paths'
import type { MachinePaths } from './collect'

/** A stale project copy cannot be hidden by a newer global provider. */
export async function transferClaudeVersion(
  paths: MachinePaths,
  cwd?: string,
): Promise<string | null> {
  const packages = await listPackages(cwd, piAgentDir(paths.env, paths.home))
  const providers = packages.filter((p) => p.name === CLAUDE_PROVIDER_PACKAGE)
  if (!providers.length || providers.some((p) => !p.installed || !p.version)) return null
  return providers
    .map((p) => p.version!)
    .reduce((oldest, version) => (meetsMinimum(version, oldest) ? oldest : version))
}
