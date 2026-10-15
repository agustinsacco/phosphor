import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { checkExtensions } from './resources'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A copy of the real pi-ext folder, without tests, as a bundle carries it. */
function copy(): string {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-resources-'))
  cpSync(join(EXTENSIONS_ROOT, 'pi-ext'), join(dir, 'pi-ext'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  })
  return dir
}

describe('bundled extensions', () => {
  it('finds the six extensions and the helpers they import', async () => {
    const check = await checkExtensions(EXTENSIONS_ROOT)
    expect(check).toMatchObject({ id: 'extensions', status: 'pass' })
    expect(check.summary).toMatch(/^6 extensions and [1-9]\d* helpers in /)
  })

  it('names a missing extension or helper', async () => {
    const root = copy()
    rmSync(join(root, 'pi-ext/headroom.ts'))
    rmSync(join(root, 'pi-ext/context-budget.ts'))
    expect(await checkExtensions(root)).toEqual({
      id: 'extensions',
      status: 'fail',
      summary: `missing from ${join(root, 'pi-ext')}: headroom.ts, context-budget.ts`,
      exit: 69,
    })
  })

  it('follows helpers to any depth, with or without an extension', async () => {
    const root = copy()
    writeFileSync(join(root, 'pi-ext/context-budget.ts'), `export * from './deeper.js'\n`)
    const check = await checkExtensions(root)
    expect(check.summary).toBe(`missing from ${join(root, 'pi-ext')}: deeper.ts`)
  })
})
