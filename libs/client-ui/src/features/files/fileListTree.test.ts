import { expect, it } from 'vitest'
import { foldFileList } from './fileListTree'

it('folds a flat list into listings, folders first and by name, keyed under the root', () => {
  const listings = foldFileList('host:h/lane:l', ['src/b.ts', 'z.md', 'src/a/x.ts', 'a.ts'])
  const names = (dir: string) => listings?.[dir]?.map((e) => e.name)
  expect(names('host:h/lane:l')).toEqual(['src', 'a.ts', 'z.md'])
  expect(names('host:h/lane:l/src')).toEqual(['a', 'b.ts'])
  expect(listings?.['host:h/lane:l/src/a']).toEqual([
    {
      name: 'x.ts',
      path: 'host:h/lane:l/src/a/x.ts',
      relativePath: 'src/a/x.ts',
      isDirectory: false,
    },
  ])
})

it('keeps paths relative under an empty root and lists an empty one', () => {
  expect(foldFileList('', ['a/b'])?.['']).toEqual([
    { name: 'a', path: 'a', relativePath: 'a', isDirectory: true },
  ])
  expect(foldFileList('root', [])).toEqual({ root: [] })
})

it('refuses a list past the depth or size cap instead of a partial tree', () => {
  expect(foldFileList('', [Array(64).fill('a').join('/')])).not.toBeNull()
  expect(foldFileList('', [Array(65).fill('a').join('/')])).toBeNull()
  expect(
    foldFileList(
      '',
      Array.from({ length: 17000 }, (_v, i) => `dir${i}/sub/file`),
    ),
  ).toBeNull()
})
