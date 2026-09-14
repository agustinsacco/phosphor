import { describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  createSandboxFolder,
  listSandboxFolders,
  openSandboxFolder,
  planSandboxRename,
  randomSandboxName,
  resolveSandboxFolder,
  validateSandboxName,
} from './sandbox'

/**
 * A scratch base directory, removed after `run`.
 *
 * Resolved, because macOS hands out `/var/folders/…` for a temp dir and `/var`
 * is itself a symlink to `/private/var`. `resolveSandboxFolder` answers in real
 * paths, so an unresolved base would make every comparison here spuriously
 * fail on one platform and pass on the other.
 */
function withBase(run: (base: string) => void): void {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'phosphor-sandbox-test-')))
  try {
    run(join(scratch, 'sandboxes'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('randomSandboxName', () => {
  it('mints an adjective-noun pair', () => {
    expect(randomSandboxName()).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('avoids a name already in use', () => {
    // A pinned RNG always draws the same pair, so the first draw collides.
    const first = randomSandboxName([], () => 0)
    expect(randomSandboxName([first], () => 0)).not.toBe(first)
  })

  it('treats names case-insensitively, as macOS and Windows do', () => {
    const first = randomSandboxName([], () => 0)
    expect(randomSandboxName([first.toUpperCase()], () => 0)).not.toBe(first)
  })
})

describe('validateSandboxName', () => {
  it('accepts an ordinary name, trimmed', () => {
    expect(validateSandboxName('  my scratch  ')).toBe('my scratch')
  })

  it('refuses a name that could escape the base or collide a transcript dir', () => {
    expect(validateSandboxName('a/b')).toBeNull()
    expect(validateSandboxName('a\\b')).toBeNull()
    // `:` mangles to `-` in pi's session dir name, so `a:b` and `a-b` would share one.
    expect(validateSandboxName('a:b')).toBeNull()
    expect(validateSandboxName('..')).toBeNull()
    expect(validateSandboxName('.hidden')).toBeNull()
  })

  it('refuses control characters', () => {
    expect(validateSandboxName(`a${String.fromCharCode(0)}b`)).toBeNull()
    expect(validateSandboxName(`a${String.fromCharCode(0x1f)}b`)).toBeNull()
    expect(validateSandboxName('a\nb')).toBeNull()
  })

  it('refuses names Windows cannot store', () => {
    expect(validateSandboxName('CON')).toBeNull()
    expect(validateSandboxName('lpt1')).toBeNull()
    expect(validateSandboxName('trailing.')).toBeNull()
    expect(validateSandboxName('a?b')).toBeNull()
  })

  it('refuses empty and over-long names', () => {
    expect(validateSandboxName('   ')).toBeNull()
    expect(validateSandboxName('x'.repeat(65))).toBeNull()
    expect(validateSandboxName('x'.repeat(64))).toBe('x'.repeat(64))
  })
})

describe('createSandboxFolder', () => {
  it('creates the base and a randomly named folder inside it', () => {
    withBase((base) => {
      const first = createSandboxFolder(base)
      const second = createSandboxFolder(base)
      expect(first).not.toBe(second)
      expect(basename(first)).toMatch(/^[a-z]+-[a-z]+$/)
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
        expect.objectContaining({ name: basename(path), path, itemCount: 1 }),
      ])
    })
  })

  it('lists any directory, including a renamed one and a legacy sandbox-N', () => {
    withBase((base) => {
      mkdirSync(base, { recursive: true })
      mkdirSync(join(base, 'sandbox-1')) // Minted before names went random.
      mkdirSync(join(base, 'my scratch')) // Renamed by the user.
      mkdirSync(join(base, '.hidden')) // Never a sandbox.
      writeFileSync(join(base, 'loose-file'), '') // A file, not a folder.

      expect(
        listSandboxFolders(base)
          .map((sandbox) => sandbox.name)
          .sort(),
      ).toEqual(['my scratch', 'sandbox-1'])
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

      expect(openSandboxFolder(base)).not.toBe(first)
      expect(listSandboxFolders(base)).toHaveLength(2)
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

  it('accepts any folder directly inside the base', () => {
    expect(resolveSandboxFolder(base, '/data/sandboxes/quiet-otter')).toBe(
      '/data/sandboxes/quiet-otter',
    )
    // Legacy names and renamed ones are sandboxes just the same.
    expect(resolveSandboxFolder(base, '/data/sandboxes/sandbox-3')).toBe(
      '/data/sandboxes/sandbox-3',
    )
  })

  it('refuses a path outside the base, traversal included', () => {
    expect(resolveSandboxFolder(base, '/Users/dev/phosphor')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/quiet-otter/../../quiet-otter')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/nested/quiet-otter')).toBeNull()
    expect(resolveSandboxFolder(base, '/data/sandboxes/.hidden')).toBeNull()
  })

  it('accepts a sandbox named through, or despite, a symlinked base', () => {
    // The shape that broke Delete on a real install: `<userData>/sandboxes`
    // was a symlink, so recents held both spellings and the lexical compare
    // called the folder's own real path "not a sandbox".
    withBase((realBase) => {
      const sandbox = createSandboxFolder(realBase)
      const linkedBase = join(dirname(realBase), 'linked-sandboxes')
      symlinkSync(realBase, linkedBase)

      expect(resolveSandboxFolder(linkedBase, join(linkedBase, basename(sandbox)))).toBe(sandbox)
      expect(resolveSandboxFolder(linkedBase, sandbox)).toBe(sandbox)
      expect(resolveSandboxFolder(realBase, join(linkedBase, basename(sandbox)))).toBe(sandbox)
    })
  })
})

describe('planSandboxRename', () => {
  it('resolves the move for a valid new name', () => {
    withBase((base) => {
      const from = createSandboxFolder(base)
      expect(planSandboxRename(base, from, 'my scratch')).toEqual({
        ok: true,
        from,
        to: join(base, 'my scratch'),
      })
    })
  })

  it('treats renaming to the current name as a no-op, not a collision', () => {
    withBase((base) => {
      const from = createSandboxFolder(base)
      expect(planSandboxRename(base, from, basename(from))).toEqual({ ok: true, from, to: from })
    })
  })

  it('allows a change of case, which is the same folder on a case-insensitive disk', () => {
    withBase((base) => {
      const from = createSandboxFolder(base)
      const plan = planSandboxRename(base, from, basename(from).toUpperCase())
      expect(plan).toEqual({ ok: true, from, to: join(base, basename(from).toUpperCase()) })
    })
  })

  it('refuses a name another sandbox already holds', () => {
    withBase((base) => {
      const from = createSandboxFolder(base)
      const other = createSandboxFolder(base)
      expect(planSandboxRename(base, from, basename(other))).toEqual({
        ok: false,
        reason: 'exists',
      })
    })
  })

  it('refuses an unusable name and a path that is not a sandbox', () => {
    withBase((base) => {
      const from = createSandboxFolder(base)
      expect(planSandboxRename(base, from, 'a/b')).toEqual({ ok: false, reason: 'invalid-name' })
      expect(planSandboxRename(base, '/elsewhere/repo', 'fine')).toEqual({
        ok: false,
        reason: 'not-a-sandbox',
      })
    })
  })
})
