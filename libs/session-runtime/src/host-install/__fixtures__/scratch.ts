import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'phosphor-install-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}
