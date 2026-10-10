import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildInto, INFO } from './output.mjs'

let dir: string
let out: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-output-'))
  out = join(dir, 'dist')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A build as `work` would leave it: one file, and a manifest listing it. */
function fakeBuild(at: string, text: string) {
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'phosphor.mjs'), text)
  writeFileSync(
    join(at, INFO),
    JSON.stringify({ schema: 1, name: 'phosphor', files: [{ path: 'phosphor.mjs' }] }),
  )
}
const entry = () => readFileSync(join(out, 'phosphor.mjs'), 'utf8')
/** Everything beside the output, which should be the output alone. */
const beside = () => readdirSync(dir).sort()

describe('buildInto', () => {
  it('builds into a fresh folder beside the output, then puts it in place', async () => {
    const seen: string[] = []
    const { value, kept } = await buildInto(out, async (stage: string) => {
      seen.push(stage)
      fakeBuild(stage, 'new')
      return 'done'
    })
    expect(seen[0]).toMatch(new RegExp(`^${dir}/\\.phosphor-build-`))
    expect([value, kept, entry(), beside()]).toEqual(['done', null, 'new', ['dist']])
  })

  it('replaces an earlier build and deletes it only once the new one is in place', async () => {
    fakeBuild(out, 'old')
    await buildInto(out, async (stage: string) => {
      fakeBuild(stage, 'new')
      expect(entry()).toBe('old')
    })
    expect([entry(), beside()]).toEqual(['new', ['dist']])
  })

  it('removes its folder and leaves an earlier build as it was when the work fails', async () => {
    fakeBuild(out, 'old')
    const failing = buildInto(out, async (stage: string) => {
      fakeBuild(stage, 'half')
      throw new Error('copy failed')
    })
    await expect(failing).rejects.toThrow('copy failed')
    expect([entry(), beside()]).toEqual(['old', ['dist']])
  })

  it('puts the earlier build back when the new one cannot take its place', async () => {
    fakeBuild(out, 'old')
    const rename = (from: string, to: string) => {
      if (to === out && !from.endsWith('-previous')) throw new Error('EXDEV')
      renameSync(from, to)
    }
    const failing = buildInto(out, async (stage: string) => fakeBuild(stage, 'new'), {
      renameSync: rename,
      rmSync,
    })
    await expect(failing).rejects.toThrow('EXDEV')
    expect([entry(), beside()]).toEqual(['old', ['dist']])
  })

  it('says where the earlier build is when it cannot be put back either', async () => {
    fakeBuild(out, 'old')
    const rename = (from: string, to: string) => {
      if (to === out) throw new Error('EXDEV')
      renameSync(from, to)
    }
    const failing = buildInto(out, async (stage: string) => fakeBuild(stage, 'new'), {
      renameSync: rename,
      rmSync,
    })
    await expect(failing).rejects.toThrow(
      /^EXDEV; the earlier build could not be put back and is at .*-previous$/,
    )
    const [aside] = beside()
    expect(beside()).toEqual([expect.stringMatching(/^\.phosphor-build-.*-previous$/)])
    expect(readFileSync(join(dir, aside!, 'phosphor.mjs'), 'utf8')).toBe('old')
  })

  it('keeps the new build, and reports the earlier one, when that cannot be deleted', async () => {
    fakeBuild(out, 'old')
    const rm = (path: string, options: object) => {
      if (path.endsWith('-previous')) throw new Error('EACCES')
      rmSync(path, options)
    }
    const { kept } = await buildInto(out, async (stage: string) => fakeBuild(stage, 'new'), {
      renameSync,
      rmSync: rm,
    })
    expect(entry()).toBe('new')
    expect(kept).toMatch(/\.phosphor-build-.*-previous$/)
    expect(readFileSync(join(kept!, 'phosphor.mjs'), 'utf8')).toBe('old')
  })

  it('refuses a folder that is not an earlier build before doing anything', async () => {
    mkdirSync(out)
    writeFileSync(join(out, 'notes.txt'), 'keep')
    let ran = false
    const refused = buildInto(out, async () => void (ran = true))
    await expect(refused).rejects.toThrow(`${out} holds no ${INFO} file: refusing to replace it`)
    expect([ran, beside(), readdirSync(out)]).toEqual([false, ['dist'], ['notes.txt']])
  })

  it('refuses, again, a folder that stopped being an earlier build while it ran', async () => {
    fakeBuild(out, 'old')
    const refused = buildInto(out, async (stage: string) => {
      fakeBuild(stage, 'new')
      writeFileSync(join(out, 'notes.txt'), 'keep')
    })
    await expect(refused).rejects.toThrow(
      'holds notes.txt, which its BUILD-INFO.json does not list',
    )
    expect([entry(), beside(), readdirSync(out).sort()]).toEqual([
      'old',
      ['dist'],
      [INFO, 'notes.txt', 'phosphor.mjs'],
    ])
  })
})
