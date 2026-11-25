import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeModule from 'node:module'

/**
 * The regression these cover: node-pty's shipped
 * `prebuilds/<platform>-<arch>/spawn-helper` unpacks as 0644, and on any
 * machine where the locally compiled `build/Release/pty.node` fails to load
 * (an x86_64 build under an arm64 Electron), node-pty falls back to that
 * prebuild and execs the non-executable helper — `posix_spawnp failed.` for
 * every terminal, forever.
 */

const roots: string[] = []

function fakeNodePty(modes: Record<string, number>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-pty-')))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{"name":"node-pty"}')
  for (const [dir, mode] of Object.entries(modes)) {
    mkdirSync(join(root, dir), { recursive: true })
    const helper = join(root, dir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, mode)
  }
  return root
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** Load the module with `require.resolve('node-pty/package.json')` redirected. */
async function loadWithPackageDir(root: string): Promise<() => void> {
  vi.resetModules()
  vi.doMock('node:module', async () => {
    const actual = await vi.importActual<typeof NodeModule>('node:module')
    return {
      ...actual,
      createRequire: () => ({ resolve: () => join(root, 'package.json') }),
    }
  })
  const { ensureSpawnHelperExecutable } = await import('./spawn-helper')
  return ensureSpawnHelperExecutable
}

afterEach(() => {
  vi.doUnmock('node:module')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ensureSpawnHelperExecutable', () => {
  it('adds the exec bit to a prebuilt helper that npm unpacked as 0644', async () => {
    const dir = `prebuilds/${process.platform}-${process.arch}`
    const root = fakeNodePty({ [dir]: 0o644 })
    const ensure = await loadWithPackageDir(root)

    ensure()

    expect(modeOf(join(root, dir, 'spawn-helper')) & 0o111).toBeTruthy()
  })

  it('repairs every candidate directory, not just the one that happens to load', async () => {
    // Which directory node-pty uses depends on which pty.node loaded, and that
    // can change (rebuild for the right arch) without this code running again.
    const prebuilds = `prebuilds/${process.platform}-${process.arch}`
    const root = fakeNodePty({ 'build/Release': 0o644, [prebuilds]: 0o644 })
    const ensure = await loadWithPackageDir(root)

    ensure()

    expect(modeOf(join(root, 'build/Release/spawn-helper')) & 0o111).toBeTruthy()
    expect(modeOf(join(root, prebuilds, 'spawn-helper')) & 0o111).toBeTruthy()
  })

  it('leaves an already-executable helper untouched', async () => {
    const root = fakeNodePty({ 'build/Release': 0o755 })
    const ensure = await loadWithPackageDir(root)

    ensure()

    expect(modeOf(join(root, 'build/Release/spawn-helper'))).toBe(0o755)
  })

  it('is a no-op when node-pty cannot be resolved at all', async () => {
    vi.resetModules()
    vi.doMock('node:module', async () => {
      const actual = await vi.importActual<typeof NodeModule>('node:module')
      return {
        ...actual,
        createRequire: () => ({
          resolve: () => {
            throw new Error('Cannot find module')
          },
        }),
      }
    })
    const { ensureSpawnHelperExecutable } = await import('./spawn-helper')

    expect(() => ensureSpawnHelperExecutable()).not.toThrow()
  })
})
