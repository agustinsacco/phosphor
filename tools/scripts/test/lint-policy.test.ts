import { ESLint } from 'eslint'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const eslint = new ESLint({
  cwd: root,
  // lintText repeatedly supplies synthetic source. CI's one-shot inference can
  // reuse the on-disk TypeScript program instead of checking that supplied text.
  overrideConfig: {
    languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
  },
})
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
    'apps/desktop/electron/preload.ts',
    'apps/desktop/electron/pi/session-writer.test.ts',
    'apps/desktop/test/main/preload.freeze.test.ts',
    'libs/host-client/src/connection.ts',
    'libs/host-client/src/connection.test.ts',
    'libs/shared/src/errors.ts',
    'libs/shared/test/ipc.freeze.test.ts',
    'libs/session-runtime/src/bundled-extensions.ts',
    'libs/session-runtime/src/pi/pi-paths.test.ts',
    'libs/pi-extensions/pi-ext/context-budget.ts',
    'libs/pi-extensions/pi-ext/context-budget.test.ts',
    rendererCaller,
    'libs/client-ui/src/features/files/FilesChangedPane.test.tsx',
    'apps/host/src/main.ts',
    'apps/control/src/main.ts',
    'apps/web/src/main.tsx',
    'apps/web/src/service-worker.ts',
    'apps/web/vite.config.ts',
  ])(
    'rejects unhandled promises in %s without missing-project failures',
    async (file) => {
      const code = `declare function accepts(callback: () => void): void;
      Promise.resolve('unhandled');
      accepts(async () => {});`
      for (const rule of ['no-floating-promises', 'no-misused-promises']) {
        expect(await messages(code, file, `@typescript-eslint/${rule}`)).toEqual([
          expect.objectContaining({ severity: 2 }),
        ])
      }
    },
    // The first file of each TS project builds that project's program: over 5 s on CI.
    60_000,
  )

  it.each([
    'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
    'tools/scripts/test/lint-policy.test.ts',
    'apps/desktop/e2e/smoke.spec.ts',
    'apps/web/e2e/fixture.ts',
  ])('does not enable typed linting outside owning projects: %s', async (file) => {
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
