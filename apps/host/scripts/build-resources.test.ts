import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { BUNDLED_EXTENSION_FILES } from '@phosphor/session-runtime/bundled-extensions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundledExtensionFiles,
  isExtensionSource,
  stageNative,
  stageResources,
} from './build-resources.mjs'

const REPO = resolve(import.meta.dirname, '../../..')
const NODE_PIN: string = JSON.parse(
  readFileSync(join(REPO, 'tools/host-release/node.json'), 'utf8'),
).version
const HOST_TARGET = `${process.platform}-${process.arch}`

let dir: string
let stage: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-build-resources-'))
  stage = join(dir, 'stage')
  mkdirSync(stage)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

/** Every entry under `at`, folders included, sorted. */
const tree = (at: string) => readdirSync(at, { recursive: true, encoding: 'utf8' }).sort()

/** A root whose pi-ext holds the six extensions and `extra`, and whose skills hold one skill. */
function root(extra: Record<string, string> = {}): string {
  const at = join(dir, 'root')
  const ext = 'root/libs/pi-extensions/pi-ext'
  for (const file of BUNDLED_EXTENSION_FILES) write(`${ext}/${file}`, `// ${file}\n`)
  for (const [path, text] of Object.entries(extra)) write(`${ext}/${path}`, text)
  write('root/libs/pi-extensions/skills/one/SKILL.md', '# One\n')
  write('root/libs/pi-extensions/skills/one/notes.test.ts', 'kept\n')
  mkdirSync(join(at, 'node_modules'))
  symlinkSync(join(REPO, 'node_modules/@phosphor'), join(at, 'node_modules/@phosphor'))
  return at
}

/** A node-pty folder validateNative accepts for `target`. */
function native(target = HOST_TARGET): string {
  const files = {
    'TARGET.json': JSON.stringify({ target, node: NODE_PIN, version: '1.1.0' }),
    'package.json': '{"private":true,"type":"commonjs"}\n',
    'lib/index.js': 'module.exports = {}\n',
    'build/Release/pty.node': 'addon',
    'build/Release/spawn-helper': 'helper',
    LICENSE: 'MIT\n',
  }
  for (const [path, text] of Object.entries(files)) write(`native/${path}`, text)
  return join(dir, 'native')
}

describe('isExtensionSource', () => {
  it.each([
    ['a TypeScript file', 'a.ts', true],
    ['a declaration file', 'a.d.ts', true],
    ['a test', 'a.test.ts', false],
    ['JavaScript', 'a.js', false],
    ['TSX', 'a.tsx', false],
    ['Markdown', 'README.md', false],
    ['a spec, which is not a test by this rule', 'a.spec.ts', true],
  ])('keeps %s: %s -> %s', (_, name, kept) => {
    write(name, 'x')
    expect(isExtensionSource(join(dir, name))).toBe(kept)
  })

  it('keeps every folder, whatever its name', () => {
    mkdirSync(join(dir, 'tests.test.ts'))
    mkdirSync(join(dir, 'assets'))
    expect([
      isExtensionSource(join(dir, 'tests.test.ts')),
      isExtensionSource(join(dir, 'assets')),
    ]).toEqual([true, true])
  })
})

describe('stageNative', () => {
  it('copies a node-pty folder that checks out for this machine by default', () => {
    const folder = native()
    stageNative(stage, folder)
    expect(tree(join(stage, 'native/node-pty'))).toEqual(tree(folder))
  })

  it('resolves the folder against the working folder', () => {
    const folder = native()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    stageNative(stage, relative(dir, folder), HOST_TARGET)
    expect(readFileSync(join(stage, 'native/node-pty/LICENSE'), 'utf8')).toBe('MIT\n')
  })

  it('checks the folder against the target it is given', () => {
    stageNative(stage, native('linux-x64'), 'linux-x64')
    expect(existsSync(join(stage, 'native/node-pty/lib/index.js'))).toBe(true)
  })

  it('copies nothing when the folder is for another target', () => {
    expect(() => stageNative(stage, native('other-target'), undefined)).toThrow(
      new Error('Native target mismatch'),
    )
    expect(readdirSync(stage)).toEqual([])
  })
})

describe('stageResources', () => {
  it("copies pi-ext with Desktop's filter and the skills whole", async () => {
    const at = root({
      'helper.ts': 'h\n',
      'helper.test.ts': 't\n',
      'README.md': 'r\n',
      'nested/deep.ts': 'd\n',
      'only-tests/a.test.ts': 't\n',
    })
    await stageResources(stage, { root: at, native: undefined, target: undefined })
    expect(tree(stage)).toEqual(
      [
        'pi-ext',
        ...BUNDLED_EXTENSION_FILES.map((file) => `pi-ext/${file}`),
        'pi-ext/helper.ts',
        'pi-ext/nested',
        'pi-ext/nested/deep.ts',
        'pi-ext/only-tests',
        'skills',
        'skills/one',
        'skills/one/SKILL.md',
        'skills/one/notes.test.ts',
      ].sort(),
    )
  })

  it('copies node-pty first when a folder is named', async () => {
    const at = root()
    await stageResources(stage, { root: at, native: native(), target: undefined })
    expect(readdirSync(stage).sort()).toEqual(['native', 'pi-ext', 'skills'])
  })

  it('copies nothing else when the node-pty folder is refused', async () => {
    const at = root()
    const failing = stageResources(stage, { root: at, native: native(), target: 'other-target' })
    await expect(failing).rejects.toThrow(new Error('Native target mismatch'))
    expect(readdirSync(stage)).toEqual([])
  })

  it('names every bundled extension pi-ext lacks, in the library order', async () => {
    const at = root()
    for (const file of ['lane-reload.ts', 'artifacts.ts']) {
      rmSync(join(at, 'libs/pi-extensions/pi-ext', file))
    }
    const failing = stageResources(stage, { root: at, native: undefined, target: undefined })
    await expect(failing).rejects.toThrow(new Error('pi-ext lacks artifacts.ts, lane-reload.ts'))
  })

  it('treats an empty node-pty name as none', async () => {
    await stageResources(stage, { root: root(), native: '', target: 'other-target' })
    expect(readdirSync(stage).sort()).toEqual(['pi-ext', 'skills'])
  })
})

describe('bundledExtensionFiles', () => {
  it("reads the six extensions from the repository's library", async () => {
    expect(await bundledExtensionFiles(REPO)).toEqual([...BUNDLED_EXTENSION_FILES])
  })

  it('reads them through the package the root resolves', async () => {
    expect(await bundledExtensionFiles(root())).toEqual([...BUNDLED_EXTENSION_FILES])
  })
})
