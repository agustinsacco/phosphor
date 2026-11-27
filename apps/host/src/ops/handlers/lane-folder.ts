import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'

type Folder = Pick<RepositorySummary, 'id' | 'name' | 'path'>

const LISTED = 10

function registered(repos: readonly Folder[]): string {
  if (repos.length === 0) return 'No folders are registered on this machine.'
  const shown = repos.slice(0, LISTED).map((r) => `${r.name} (${r.path})`)
  const more = repos.length > LISTED ? `, and ${repos.length - LISTED} more` : ''
  return `Registered folders: ${shown.join(', ')}${more}.`
}

/**
 * The folder a `--folder` value names: its ID, its path, or a name only one
 * registered folder has. IDs and paths win, so a name never shadows them.
 */
export function findFolder<T extends Folder>(
  repos: readonly T[],
  folder: string,
): T | 'ambiguous' | undefined {
  const exact = repos.find((r) => r.id === folder || r.path === folder)
  if (exact) return exact
  const named = repos.filter((r) => r.name === folder)
  if (named.length > 1) return 'ambiguous'
  return named[0]
}

/** `findFolder`, or a refusal that names what is registered. */
export function requireFolder<T extends Folder>(repos: readonly T[], folder: string): T {
  const found = findFolder(repos, folder)
  if (found === 'ambiguous')
    throw new OpRefusal(
      'bad-request',
      `More than one registered folder is named ${folder}; pass its path or ID. ${registered(repos.filter((r) => r.name === folder))}`,
    )
  if (!found)
    throw new OpRefusal(
      'bad-request',
      `No registered folder matches ${folder}. Pass a folder name, path or ID. ${registered(repos)}`,
    )
  return found
}

/** A list filter keeps an unknown value as-is, so it matches nothing rather than failing. */
export function folderFilter<A extends { folder?: string }>(repos: readonly Folder[], a: A): A {
  if (!a.folder) return a
  const found = findFolder(repos, a.folder)
  return found && found !== 'ambiguous' ? { ...a, folder: found.id } : a
}

/** A bare model ID: pi may not find it without its provider. */
export const MODEL_HINT =
  'Pass --model as provider/id, for example pi-claude-cli/claude-opus-5-5. Model IDs alone may not resolve.'
