import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSandboxFolder,
  listSandboxFolders,
  nextSandboxName,
  openSandboxFolder,
  resolveSandboxFolder,
} from './sandbox'

/** A scratch base directory, removed after `run`. */
function withBase(run: (base: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), 'phosphor-sandbox-test-'))
  try {
    run(join(scratch, 'sandboxes'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('nextSandboxName', () => {
  it('starts at sandbox-1 for an empty base', () => {
    expect(nextSandboxName([])).toBe('sandbox-1')
  })

  it('continues past the highest existing number', () => {
    expect(nextSandboxName(['sandbox-1', 'sandbox-3'])).toBe('sandbox-4')
  })

  it('ignores names that are not exactly sandbox-N', () => {
    expect(nextSandboxName(['sandbox-abc', 'sandbox-2x', 'other', '.DS_Store'])).toBe('sandbox-1')
  })
})

describe('createSandboxFolder', () => {
  it('creates the base and a fresh numbered folder inside it', () => {
    withBase((base) => {
      const first = createSandboxFolder(base)
      const second = createSandboxFolder(base)
      expect(first).toBe(join(base, 'sandbox-1'))
      expect(second).toBe(join(base, 'sandbox-2'))
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)
    })
  })
})

describe('listSandboxFolders', () => {
  it('is empty when no sandbox has ever been created', () => {
    withBase((base) => {
      expect(listSandboxFolders(base)).toEqual([])
    })
  })

  it('counts real entries and ignores dotfiles', () => {
    withBase((base) => {
      const path = createSandboxFolder(base)
      writeFileSync(join(path, '.DS_Store'), '')
      writeFileSync(join(path, 'notes.md'), 'hi')

      expect(listSandboxFolders(base)).toEqual([
        expect.objectContaining({ name: 'sandbox-1', path, itemCount: 1 }),
      ])
    })
  })

  it('lists only sandbox-N directories', () => {
    withBase((base) => {
      createSandboxFolder(base)
      mkdirSync(join(base, 'not-a-sandbox'))
      writeFileSync(join(base, 'sandbox-9'), '') // A file, not a folder.

      expect(listSandboxFolders(base).map((sandbox) => sandbox.name)).toEqual(['sandbox-1'])
    })
  })

  it('puts the most recently touched sandbox first', () => {
    withBase((base) => {
      const first = createSandboxFolder(base)
      const second = createSandboxFolder(base)
      // mkdir timestamps can land in the same millisecond; make the order real.
      const old = new Date(Date.now() - 60_000)
      utimesSync(second, old, old)

      expect(listSandboxFolders(base).map((sandbox) => sandbox.path)).toEqual([first, second])
    })
  })
})

describe('openSandboxFolder', () => {
  it('hands back the same empty sandbox instead of minting another', () => {
    withBase((base) => {
      const first = openSandboxFolder(base)
      expect(openSandboxFolder(base)).toBe(first)
      expect(listSandboxFolders(base)).toHaveLength(1)
    })
  })

  it('mints a fresh one once the sandbox holds real work', () => {
    withBase((base) => {
      const first = openSandboxFolder(base)
      writeFileSync(join(first, 'game.ts'), 'export {}')

      const second = openSandboxFolder(base)
      expect(second).toBe(join(base, 'sandbox-2'))
    })
  })

  it('does not count a dotfile as real work', () => {
    withBase((base) => {
      const first = openSandboxFolder(base)
      writeFileSync(join(first, '.DS_Store'), '')

      expect(openSandboxFolder(base)).toBe(first)
    })
  })
})

describe('resolveSandboxFolder', () => {
  const base = '/data/sandboxes'

  it('accepts a sandbox-N folder directly inside the base', () => {
    expect(resolveSandboxFolder(base, '/data/sandboxes/sandbox-3')).toBe(
      '/data/sandboxes/sandbox-3',
    )
  })

  it('refuses anything that is not a sandbox-N name', () => {
    expect(resolveSandboxFolder(base, '/data/sandboxes/my-project')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/sandbox-3x')).toBeNull()
  })

  it('refuses a path outside the base, traversal included', () => {
    expect(resolveSandboxFolder(base, '/Users/dev/phosphor')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/sandbox-1/../../sandbox-1')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/nested/sandbox-1')).toBeNull()
  })
})
