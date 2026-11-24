import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ensureLauncher } from './launcher'
it('creates its symlink idempotently, but leaves a foreign launcher alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'local-launcher-'))
  try {
    const path = join(home, '.local/bin/phosphor')
    expect(ensureLauncher(home)).toBe('created')
    expect(ensureLauncher(home)).toBe('ours')
    rmSync(path)
    writeFileSync(path, 'shell command')
    expect(ensureLauncher(home)).toBe('foreign')
    expect(readFileSync(path, 'utf8')).toBe('shell command')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
