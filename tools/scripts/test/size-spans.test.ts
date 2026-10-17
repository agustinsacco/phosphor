import { describe, expect, it } from 'vitest'
import { measureSource } from '../size-spans.mjs'

const functions = (file: string, source: string) =>
  measureSource(file, source).filter((span) => span.rule === 'function80')

const body = (count: number) => Array.from({ length: count }, () => '  work()').join('\n')

describe('size-spans whole-span measurements', () => {
  it('counts factory closures and returned object methods in every enclosing span', () => {
    const source = `export function factory() {\n  return {\n    async run() {\n${body(81)}\n    },\n  }\n}`
    const spans = functions('src/factory.ts', source)
    expect(spans.map(({ lines }) => lines)).toEqual([87, 83])
    expect(spans.map(({ key }) => key)).toEqual([
      'src/factory.ts::factory[1]',
      'src/factory.ts::factory[1]/run[1]',
    ])
  })

  it('does not subtract Zustand create callbacks or nested callbacks', () => {
    const source = `const useStore = create(() => ({\n  run: () => {\n${body(81)}\n  },\n}))`
    const spans = functions('src/store.ts', source)
    expect(spans.map(({ lines }) => lines)).toEqual([85, 83])
    expect(spans[0]?.key).toBe('src/store.ts::useStore[1]')
    expect(spans[1]?.key).toBe('src/store.ts::useStore[1]/run[1]')
  })

  it('measures TSX, anonymous functions, constructors, accessors and computed methods', () => {
    const source = `class View {\n  constructor() {}\n  get name() { return 'a' }\n  ['render']() { return <button onClick={() => {\n    work()\n  }}>OK</button> }\n}\nconst handlers = [function () {\n  work()\n}, () => work()]`
    const spans = functions('view.tsx', source)
    expect(spans.map(({ lines }) => lines)).toEqual([1, 1, 3, 3, 3, 1])
    expect(new Set(spans.map(({ key }) => key)).size).toBe(6)
    expect(spans[2]?.key).toContain('View[1]/render[1]')
  })

  it.each(['ts', 'tsx', 'js', 'mjs', 'cjs'])(
    'parses %s and uses LF/CRLF-equivalent spans',
    (ext) => {
      const lf = 'export const run = () => {\n  work()\n}\n'
      expect(measureSource(`run.${ext}`, lf.replaceAll('\n', '\r\n'))).toEqual(
        measureSource(`run.${ext}`, lf),
      )
      expect(functions(`run.${ext}`, lf)[0]?.lines).toBe(3)
      expect(measureSource(`run.${ext}`, lf)[0]?.lines).toBe(3)
    },
  )

  it('keeps lexical keys stable across line shifts and unrelated named siblings', () => {
    const source = 'function factory() { return { run() {}, stop() {} } }'
    const before = functions('a.ts', source).map(({ key }) => key)
    expect(
      functions('a.ts', `\n\nfunction unrelated() {}\n${source}`)
        .slice(1)
        .map(({ key }) => key),
    ).toEqual(before)
  })

  it('uses sibling ordinals to distinguish anonymous callbacks', () => {
    const spans = functions('a.js', 'listen(() => {}); listen(() => {});')
    expect(spans.map(({ key }) => key)).toEqual(['a.js::listen[1]', 'a.js::listen[2]'])
  })

  it('treats only actual test suite registrations as containers', () => {
    const suite = `describe('suite', () => {\n${body(81)}\n  it('case', () => {\n${body(81)}\n  })\n})`
    expect(functions('a.test.ts', suite).map(({ lines }) => lines)).toEqual([83])
    expect(functions('a.ts', suite).map(({ lines }) => lines)).toEqual([166, 83])
    expect(
      functions('a.test.ts', `const describe = (cb) => cb();\ndescribe(() => {\n${body(81)}\n})`),
    ).toHaveLength(2)
  })

  it('handles imported aliases, nested suites and each/skip/only suites without exempting tests', () => {
    const source = `import { describe as suite, it } from 'vitest'\nsuite.each([1])('suite', () => {\n  suite.skip('inner', () => {\n    it('test', () => {\n${body(81)}\n    })\n  })\n})`
    expect(functions('a.test.ts', source)).toHaveLength(1)
    expect(functions('a.test.ts', source)[0]?.lines).toBe(83)
  })

  it.each(['a.test.ts', 'a.spec.tsx', '__tests__/a.ts', 'test/a.ts'])(
    'applies test-file800 to %s',
    (file) => {
      expect(measureSource(file, body(801))[0]).toMatchObject({ rule: 'test-file800', limit: 800 })
    },
  )

  it('reports invalid source instead of silently measuring a partial AST', () => {
    expect(() => measureSource('a.ts', 'function broken( {')).toThrow(/a.ts/)
  })
})

describe('size-spans lexical identity and registration boundaries', () => {
  it('includes named object and namespace ownership and escapes key delimiters', () => {
    const source = `namespace Service {\nconst api = { options: { run() {} }, 'odd::/[]'() {} }\n}`
    const keys = functions('a.ts', source).map(({ key }) => key)
    expect(keys).toEqual([
      'a.ts::Service[1]/api[1]/options[1]/run[1]',
      'a.ts::Service[1]/api[1]/odd%3A%3A%2F%5B%5D[1]',
    ])
  })

  it('does not exempt local objects, shadowed imports, var hoisting or named function expressions', () => {
    const sources = [
      `const other = { describe: (name, cb) => cb() }; other.describe('s', () => {\n${body(81)}\n})`,
      `import { describe } from 'vitest'; function run(describe) { describe('s', () => {\n${body(81)}\n}) }`,
      `function run() { if (true) { var describe = register }; describe('s', () => {\n${body(81)}\n}) }`,
      `const run = function describe() { describe('s', () => {\n${body(81)}\n}) }`,
    ]
    for (const source of sources) {
      expect(functions('a.test.ts', source).some(({ lines }) => lines === 83)).toBe(true)
    }
  })

  it('recognizes namespace and Playwright suite registrations but still counts their tests', () => {
    const source = `import * as v from 'vitest'; import { test } from '@playwright/test';\nv.describe.only('suite', () => {\n${body(81)}\n})\ntest.describe('e2e', () => {\n  test('case', async () => {\n${body(81)}\n  })\n})`
    expect(functions('a.spec.ts', source).map(({ lines }) => lines)).toEqual([83])
  })
})
