import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Stands in for the pinned Node binary inside a test's runtime archive, and
 * returns the folder the caller removes with its fixture.
 *
 * Copying the real binary made every fixture gzip ~100 MB at level 9: about
 * 80 s per suite on CI. The shim is a few bytes and still runs this test's Node,
 * through a symlink in its own temp folder. That folder is outside the fixture
 * root and the home folder, which the bundle scan forbids in release text, and
 * children run with a scrubbed environment, so a variable cannot carry it.
 */
export function writeNodeShim(file: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'phosphor-test-node-'))
  const link = join(folder, 'node')
  symlinkSync(process.execPath, link)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(link)} "$@"\n`, { mode: 0o755 })
  return folder
}
