import { ESLint } from 'eslint'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const eslint = new ESLint({ cwd: root })
const renderer = 'libs/client-ui/src/lib/rpc.ts'
const rendererCaller = 'libs/client-ui/src/stores/sessions.ts'

async function messages(code: string, filePath: string, ruleId: string) {
  const [result] = await eslint.lintText(code, { filePath })
  expect(result?.messages.filter((message) => message.fatal)).toEqual([])
  return result!.messages.filter((message) => message.ruleId === ruleId)
}

async function severity(file: string, rule: string) {
  const config = await eslint.calculateConfigForFile(file)
  return config?.rules?.[rule]?.[0] ?? 0
}

describe('eslint policy', () => {
  // Loading the config, plugins and parser is a one-off cost the first lint
  // pays; on a loaded CI machine it alone outran a test's 5 s budget.
  beforeAll(async () => {
    await eslint.lintText('', { filePath: rendererCaller })
  }, 60_000)

  it('preserves the existing renderer prompt error and Host boundary errors', async () => {
    expect(await messages('window.prompt("name")', rendererCaller, 'no-restricted-syntax')).toEqual(
      [expect.objectContaining({ severity: 2 })],
    )
    expect(
      await messages('import "electron"', 'apps/host/src/main.ts', 'no-restricted-imports'),
    ).toEqual([expect.objectContaining({ severity: 2 })])
  })

  it('applies hooks rules only in renderer source and relocated renderer tests', async () => {
    for (const file of [
      rendererCaller,
      'apps/web/src/main.tsx',
      'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
    ]) {
      expect(await severity(file, 'react-hooks/rules-of-hooks')).toBe(2)
      expect(await severity(file, 'react-hooks/exhaustive-deps')).toBe(1)
    }
    const code = `import { useEffect, useState } from 'react'
      export function View({ enabled, value }: { enabled: boolean; value: string }) {
        if (enabled) useState(0)
        useEffect(() => { console.log(value) }, [])
        return null
      }`
    for (const [rule, level] of [
      ['react-hooks/rules-of-hooks', 2],
      ['react-hooks/exhaustive-deps', 1],
    ] as const) {
      expect(await messages(code, rendererCaller, rule)).toEqual([
        expect.objectContaining({ severity: level }),
      ])
      expect(await severity('apps/host/src/main.ts', rule)).toBe(0)
      expect(await severity('apps/desktop/electron/preload.ts', rule)).toBe(0)
    }
  })

  it.each([
    rendererCaller,
    'apps/desktop/electron/preload.ts',
    'apps/host/src/main.ts',
    'apps/desktop/e2e/smoke.spec.ts',
    'tools/scripts/test/lint-policy.test.ts',
  ])('never builds a TypeScript program: %s', async (file) => {
    const config = await eslint.calculateConfigForFile(file)
    expect(config?.languageOptions?.parserOptions?.projectService).toBeUndefined()
    expect(config?.languageOptions?.parserOptions?.project).toBeUndefined()
    for (const rule of ['no-floating-promises', 'no-misused-promises']) {
      expect(await severity(file, `@typescript-eslint/${rule}`)).toBe(0)
    }
  })

  it.each(['window.confirm("sure?")', 'window["confirm"]("sure?")'])(
    'rejects native confirmation: %s',
    async (code) => {
      expect(await messages(code, rendererCaller, 'no-restricted-properties')).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
      expect(await severity('apps/desktop/electron/preload.ts', 'no-restricted-properties')).toBe(0)
    },
  )

  it.each([
    'window.phosphor.piCommand("id", {})',
    'window.phosphor["piCommand"]("id", {})',
    'window["phosphor"].piCommand("id", {})',
    'window["phosphor"]["piCommand"]("id", {})',
    'window?.phosphor?.piCommand("id", {})',
    '(window as Window).phosphor.piCommand("id", {})',
    'window.phosphor!.piCommand("id", {})',
    'window[`phosphor`][`piCommand`]("id", {})',
  ])('rejects raw RPC escape hatches: %s', async (code) => {
    expect(await messages(code, rendererCaller, 'phosphor/no-raw-pi-command')).toEqual([
      expect.objectContaining({ severity: 2 }),
    ])
    expect(await messages(code, renderer, 'phosphor/no-raw-pi-command')).toEqual([])
  })

  it('allows RPC wrappers and narrowly exempts test doubles, not production helpers', async () => {
    expect(
      await messages('piCall("id", {})', rendererCaller, 'phosphor/no-raw-pi-command'),
    ).toEqual([])
    for (const file of [
      'libs/client-ui/src/lib/rpc.test.ts',
      'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
      'apps/desktop/electron/preload.ts',
    ]) {
      expect(await severity(file, 'phosphor/no-raw-pi-command')).toBe(0)
    }
    expect(
      await severity('libs/client-ui/src/dev/mockPhosphor.ts', 'phosphor/no-raw-pi-command'),
    ).toBe(2)
  })

  it('exempts test mocks of window.confirm', async () => {
    for (const file of [
      'libs/client-ui/src/features/files/FilesChangedPane.test.tsx',
      'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
    ])
      expect(await severity(file, 'no-restricted-properties')).toBe(0)
  })
})

// The real .oxlintrc.json against synthetic files in a scratch project with one
// tsconfig: a probe written into the checkout would race tests that scan it.
// Whole-repository project resolution is CI's own `npm run lint`.
describe('oxlint promise policy', () => {
  const owned = [
    'apps/desktop/electron/preload.ts',
    'apps/desktop/electron/pi/session-writer.test.ts',
    'apps/desktop/test/main/preload.freeze.test.ts',
    'libs/host-client/src/connection.ts',
    'libs/shared/src/errors.ts',
    'libs/shared/test/ipc.freeze.test.ts',
    'libs/session-runtime/src/bundled-extensions.ts',
    'libs/pi-extensions/pi-ext/context-budget.ts',
    'libs/client-ui/src/stores/sessions.ts',
    'libs/client-ui/src/features/files/FilesChangedPane.test.tsx',
    'apps/host/src/main.ts',
    'apps/control/src/main.ts',
    'apps/web/src/main.tsx',
    'apps/web/src/service-worker.ts',
    'apps/web/vite.config.ts',
  ]
  const unowned = [
    'apps/desktop/src/main.tsx',
    'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
    'apps/desktop/e2e/smoke.spec.ts',
    'apps/web/e2e/fixture.ts',
    'tools/scripts/test/lint-policy.test.ts',
  ]
  const probe = `declare function accepts(callback: () => void): void
Promise.resolve('unhandled')
accepts(async () => {})
export {}
`
  let dir = ''
  let found = new Map<string, string[]>()
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-oxlint-policy-'))
    copyFileSync(join(root, '.oxlintrc.json'), join(dir, '.oxlintrc.json'))
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, jsx: 'preserve', lib: ['ES2023'] },
        include: ['**/*.ts', '**/*.tsx'],
      }),
    )
    for (const file of [...owned, ...unowned]) {
      mkdirSync(join(dir, dirname(file)), { recursive: true })
      writeFileSync(join(dir, file), probe)
    }
    const result = spawnSync(
      process.execPath,
      [join(root, 'node_modules/oxlint/bin/oxlint'), '--type-aware', '--format=json', '.'],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 },
    )
    const diagnostics = (
      JSON.parse(result.stdout) as { diagnostics: { filename?: string; code?: string }[] }
    ).diagnostics
    found = new Map()
    for (const { filename, code } of diagnostics)
      if (filename && code) found.set(filename, [...(found.get(filename) ?? []), code])
  }, 60_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.each(owned)('rejects unhandled promises in %s', (file) => {
    expect(found.get(file)?.sort()).toEqual([
      'typescript(no-floating-promises)',
      'typescript(no-misused-promises)',
    ])
  })

  it.each(unowned)('leaves files outside owning projects syntax-only: %s', (file) => {
    expect(found.get(file)).toBeUndefined()
  })
})
