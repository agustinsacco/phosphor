import { expect, it } from 'vitest'
import { parseFileQuery } from './fileQuery'

it.each([
  ['src/a.ts:12', { path: 'src/a.ts', target: { line: 12 } }],
  ['src/a.ts:12:8', { path: 'src/a.ts', target: { line: 12, column: 8 } }],
  ['C:\\repo\\a.ts:12:8', { path: 'C:\\repo\\a.ts', target: { line: 12, column: 8 } }],
  ['a.ts', { path: 'a.ts' }],
  ['a.ts:0', { path: 'a.ts:0' }],
  ['a.ts:9007199254740992', { path: 'a.ts:9007199254740992' }],
])('parses %s', (query, expected) => expect(parseFileQuery(query)).toEqual(expected))
