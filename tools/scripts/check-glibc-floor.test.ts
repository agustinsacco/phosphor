import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareVersions, GLIBC_FLOOR, maxGlibc } from './check-glibc-floor.mjs'

/**
 * v0.1.608 shipped a node-pty built on a glibc 2.42 runner; it could not load
 * on Ubuntu 22.04 and the app died before opening a window. These pin the
 * version arithmetic the release guard relies on.
 */
describe('check-glibc-floor', () => {
  it('compares dotted versions numerically, not lexically', () => {
    expect(compareVersions('2.42', '2.35')).toBeGreaterThan(0)
    expect(compareVersions('2.4', '2.35')).toBeLessThan(0)
    expect(compareVersions('2.35', '2.35')).toBe(0)
    expect(compareVersions('2.3.4', '2.3')).toBeGreaterThan(0)
  })

  it('reads the highest GLIBC requirement from objdump -T output', () => {
    const dump = [
      '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) close',
      '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.42) openpty',
      '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.34) pthread_create',
    ].join('\n')
    expect(maxGlibc(dump)).toBe('2.42')
    expect(maxGlibc('no versioned symbols')).toBeNull()
  })

  it('flags the v0.1.608 requirement against the floor', () => {
    expect(compareVersions('2.42', GLIBC_FLOOR)).toBeGreaterThan(0)
  })
})

describe('check-glibc-floor CLI', () => {
  it('fails when no ELF binaries are found (a broken path must not pass)', async () => {
    const { spawnSync } = await import('node:child_process')
    const dir = mkdtempSync(join(tmpdir(), 'glibc-floor-'))
    try {
      mkdirSync(join(dir, 'x'))
      writeFileSync(join(dir, 'x', 'pty.node'), 'not an elf')
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, 'check-glibc-floor.mjs'), dir],
        { encoding: 'utf8' },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('no ELF native binaries')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
