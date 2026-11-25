import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadHostPty } from './native'

let bundleEntry: string
vi.mock('node:module', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:module')>()
  return { ...mod, createRequire: () => mod.createRequire(bundleEntry) }
})

it('repairs a helper installed by the older extractor before the first spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-native-'))
  try {
    bundleEntry = join(root, 'phosphor.mjs')
    const pkg = join(root, 'native/node-pty')
    const helper = join(pkg, 'build/Release/spawn-helper')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, 'helper')
    chmodSync(helper, 0o644)
    mkdirSync(join(pkg, 'lib'))
    writeFileSync(join(pkg, 'lib/index.js'), 'exports.spawn = () => {}')
    expect(loadHostPty()).not.toBeNull()
    expect(statSync(helper).mode & 0o777).toBe(0o755)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
