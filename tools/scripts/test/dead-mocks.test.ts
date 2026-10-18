import { describe, expect, it } from 'vitest'
import { findDeadMocks, scanSource } from '../dead-mocks.mjs'

const run = (files: Record<string, string>) =>
  findDeadMocks(Object.keys(files), (file: string) => files[file]!)

describe('dead-mocks', () => {
  it('keeps a mock of a module the test reaches through its imports', () => {
    expect(
      run({
        'a/x.test.ts': "vi.mock('./dep')\nimport { f } from './subject'",
        'a/subject.ts': "export { g } from './middle'",
        'a/middle.ts': "import { h } from './dep'",
        'a/dep.ts': 'export const h = 1',
      }),
    ).toEqual([])
  })

  it('reports a mock of a module nothing the test loads imports', () => {
    expect(
      run({
        'a/x.test.ts': "import { f } from './subject'\n\nvi.mock('./old')",
        'a/subject.ts': 'export const f = 1',
        'a/old.ts': 'export const o = 1',
      }),
    ).toEqual([{ file: 'a/x.test.ts', line: 3, specifier: './old', target: 'a/old.ts' }])
  })

  it('does not count type-only imports, which are erased at runtime', () => {
    const dead = run({
      'a/x.test.ts': "import { f } from './subject'\nvi.mock('./dep')",
      'a/subject.ts': "import type { T } from './dep'\nexport type { U } from './dep'",
      'a/dep.ts': 'export type T = 1',
    })
    expect(dead.map((entry) => entry.target)).toEqual(['a/dep.ts'])
  })

  it('does not count imports made inside a mock factory', () => {
    const dead = run({
      'a/x.test.ts': "vi.mock('./dep', async () => await import('./other'))\nvi.mock('./other')",
      'a/dep.ts': '',
      'a/other.ts': '',
    })
    expect(dead.map((entry) => entry.specifier)).toEqual(['./dep', './other'])
  })

  it('follows dynamic imports, require, aliases and vi.mock(import()) targets', () => {
    expect(
      run({
        'libs/client-ui/src/x.test.tsx':
          "vi.mock(import('@/lazy'))\nvi.doMock('@/req')\nconst m = await import('./subject')",
        'libs/client-ui/src/subject.tsx': "const l = () => import('./lazy')\nrequire('./req')",
        'libs/client-ui/src/lazy.tsx': '',
        'libs/client-ui/src/req.ts': '',
      }),
    ).toEqual([])
  })

  it('ignores packages and builtins, which it cannot resolve', () => {
    expect(run({ 'a/x.test.ts': "vi.mock('electron')\nvi.mock('node:fs')" })).toEqual([])
  })

  it('records mock lines and runtime imports for one file', () => {
    expect(scanSource('x.test.ts', "import a from './a'\nvi.mock('./b', () => ({}))")).toEqual({
      imports: ['./a'],
      mocks: [{ specifier: './b', line: 2 }],
    })
  })
})
