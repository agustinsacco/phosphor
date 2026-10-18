import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const facade = resolve(import.meta.dirname, '../rpc.ts')
const responses = resolve(import.meta.dirname, 'responses.ts')
const negativeFixture = resolve(import.meta.dirname, '__fixtures__/drift-negative.ts')
const timeout = 30_000

/** Compile real mirror modules, overriding only the deliberately mutated source text. */
function compileMirror(rewrites: ReadonlyMap<string, string> = new Map(), root = facade) {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(import.meta.dirname, '../../tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  if (!config) throw new Error('Shared TypeScript configuration did not parse')
  const host = ts.createCompilerHost(config.options)
  const readFile = host.readFile.bind(host)
  host.readFile = (file) => rewrites.get(resolve(file)) ?? readFile(file)
  const program = ts.createProgram([root], config.options, host)
  return ts.getPreEmitDiagnostics(program).map(({ code, file, start, messageText }) => {
    const line = file && start !== undefined ? file.getLineAndCharacterOfPosition(start).line : -1
    return {
      code,
      file: file ? resolve(file.fileName) : undefined,
      source: file?.text.split('\n')[line]?.trim(),
      message: ts.flattenDiagnosticMessageText(messageText, '\n'),
    }
  })
}

function changeResponseMap(before: string, after: string) {
  const source = readFileSync(responses, 'utf8')
  expect(source.split(before)).toHaveLength(2)
  return new Map([[responses, source.replace(before, after)]])
}

it('compiles the actual facade and both consumed negative constraints', { timeout }, () => {
  expect(compileMirror()).toEqual([])
  expect(compileMirror(new Map(), negativeFixture)).toEqual([])
})

it(
  'rejects a deleted actual response entry at the production missing-key guard',
  { timeout },
  () => {
    const errors = compileMirror(changeResponseMap('  abort: undefined\n', ''))
    expect(errors).toEqual([
      {
        code: 2344,
        file: facade,
        source: expect.stringContaining('export type _NoMissingResponseKeys = AssertNever<'),
        message: expect.stringContaining('does not satisfy the constraint'),
      },
    ])
  },
)

it('rejects an extra actual response entry at the production extra-key guard', { timeout }, () => {
  const errors = compileMirror(
    changeResponseMap(
      'export interface RpcResponseDataMap {',
      'export interface RpcResponseDataMap {\n  stale_command: undefined',
    ),
  )
  expect(errors).toEqual([
    {
      code: 2344,
      file: facade,
      source: expect.stringContaining('export type _NoExtraResponseKeys = AssertNever<'),
      message: expect.stringContaining('does not satisfy the constraint'),
    },
  ])
})

it('reports both fixture errors when their suppression directives are removed', { timeout }, () => {
  const source = readFileSync(negativeFixture, 'utf8').replaceAll(
    '@ts-expect-error',
    'expected TS2344:',
  )
  const errors = compileMirror(new Map([[negativeFixture, source]]), negativeFixture)
  expect(errors.map(({ code, file }) => ({ code, file }))).toEqual([
    { code: 2344, file: negativeFixture },
    { code: 2344, file: negativeFixture },
  ])
})
