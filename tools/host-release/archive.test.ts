import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { decompressRelease, extractRelease } from '@phosphor/session-runtime/host-install/archive'

it('installs the archived node-pty helper as executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-modes-'))
  try {
    const stage = join(root, 'stage')
    const helper = 'lib/native/node-pty/build/Release/spawn-helper'
    mkdirSync(dirname(join(stage, helper)), { recursive: true })
    writeFileSync(join(stage, helper), 'helper', { mode: 0o644 })
    const bytes = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import {archive} from './tools/host-release/archive.mjs'; process.stdout.write(archive(process.argv[1]))`,
      stage,
    ])
    const target = join(root, 'installed')
    extractRelease(decompressRelease(bytes), target)
    expect(statSync(join(target, helper)).mode & 0o777).toBe(0o755)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
