import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  BUNDLED_EXTENSION_FILES,
  bundledExtensions,
} from '@phosphor/session-runtime/bundled-extensions'
import { fail, pass, type Check } from '../checks'

/** `from './x'` and `import('./x')`: a helper an extension loads from beside itself. */
const LOCAL_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.\/[^'"]+)['"]/g

/**
 * The six extensions every session loads, and each helper they import from
 * beside themselves, must be under `<resourceRoot>/pi-ext/`. One missing
 * would otherwise surface later, as a session that cannot start.
 */
export async function checkExtensions(resourceRoot: string): Promise<Check> {
  const dir = join(resourceRoot, 'pi-ext')
  const pending = bundledExtensions(resourceRoot)
  const seen = new Set<string>()
  const missing: string[] = []
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      missing.push(relative(dir, file))
      continue
    }
    for (const [, specifier] of source.matchAll(LOCAL_IMPORT)) {
      pending.push(`${join(dirname(file), specifier!).replace(/\.(js|ts)$/, '')}.ts`)
    }
  }
  if (missing.length > 0) return fail('extensions', `missing from ${dir}: ${missing.join(', ')}`)
  const helpers = seen.size - BUNDLED_EXTENSION_FILES.length
  return pass(
    'extensions',
    `${BUNDLED_EXTENSION_FILES.length} extensions and ${helpers} helpers in ${dir}`,
  )
}
