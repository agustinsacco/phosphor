import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUNDLED_EXTENSION_FILES, bundledExtensions } from './bundled-extensions'

const root = resolve(import.meta.dirname, '../../..')

describe('bundledExtensions', () => {
  it('includes production extension entry points, without helpers, tests or optional packages', () => {
    // Modules imported by an extension, not loaded separately with -e:
    // Budget/files/ledger helpers belong to context-breakdown; store/snapshot helpers to artifacts.
    const imported = new Set([
      'context-budget.ts',
      'context-files.ts',
      'message-ledger.ts',
      'swarm.ts',
      'artifact-store.ts',
      'subagent-snapshot.ts',
    ])
    const files = readdirSync(join(root, 'libs/pi-extensions/pi-ext')).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !imported.has(name),
    )
    expect([...BUNDLED_EXTENSION_FILES].sort()).toEqual(files.sort())
    expect(BUNDLED_EXTENSION_FILES).toHaveLength(7)
  })

  it('uses the supplied development, packaged or standalone resource root', () => {
    for (const base of [
      join(root, 'libs/pi-extensions'),
      join(root, 'resources'),
      join(root, 'host', 'version with spaces'),
    ]) {
      expect(bundledExtensions(base)).toEqual(
        BUNDLED_EXTENSION_FILES.map((name) => join(base, 'pi-ext', name)),
      )
    }
  })

  it('returns a new array so a caller cannot change later sessions', () => {
    bundledExtensions(root).pop()
    expect(bundledExtensions(root)).toHaveLength(7)
  })
})
