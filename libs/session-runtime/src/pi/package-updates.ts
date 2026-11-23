import type { PiPackageEntry } from '@phosphor/shared/models'
import { npmNameFromSpec } from './packages'
/**
 * Latest published version for each npm-sourced package, from the registry.
 *
 * pi installs a package once and never moves it again on its own, so a
 * fix published upstream is invisible until someone runs `pi update`. This
 * is what lets the UI say "0.4.3 → 0.4.4" instead of the user discovering
 * months later that they are running old code.
 *
 * Best-effort by design: offline, a private registry, or an unpublished
 * package all yield `null` rather than an error, because a failed version
 * check must never make package management look broken.
 */
export async function checkPackageUpdates(
  entries: Pick<PiPackageEntry, 'spec' | 'kind'>[],
): Promise<Record<string, string | null>> {
  const npmEntries = entries.filter((entry) => entry.kind === 'npm')
  const results = await Promise.all(
    npmEntries.map(
      async (entry) => [entry.spec, await latestNpmVersion(npmNameFromSpec(entry.spec))] as const,
    ),
  )
  return Object.fromEntries(results)
}

/** `latest` dist-tag from the npm registry, or null on any failure. */
export async function latestNpmVersion(name: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}
