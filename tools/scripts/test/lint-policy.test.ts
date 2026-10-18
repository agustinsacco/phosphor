import { ESLint } from 'eslint'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const eslint = new ESLint({ cwd: root })
const renderer = 'apps/desktop/src/lib/rpc.ts'
const rendererCaller = 'apps/desktop/src/stores/sessions.ts'

async function messages(code: string, filePath: string, ruleId: string) {
  const [result] = await eslint.lintText(code, { filePath })
  expect(result?.messages.filter((message) => message.fatal)).toEqual([])
  return result!.messages.filter((message) => message.ruleId === ruleId)
}

async function severity(file: string, rule: string) {
  const config = await eslint.calculateConfigForFile(file)
  return config?.rules?.[rule]?.[0] ?? 0
}

describe('eslint staged warning policy', () => {
  it('preserves the existing renderer prompt error and Host boundary errors', async () => {
    expect(await messages('window.prompt("name")', rendererCaller, 'no-restricted-syntax')).toEqual(
      [expect.objectContaining({ severity: 2 })],
    )
    expect(
      await messages('import "electron"', 'apps/host/src/index.ts', 'no-restricted-imports'),
    ).toEqual([expect.objectContaining({ severity: 2 })])
  })

  it('stages hooks warnings only in renderer source and relocated renderer tests', async () => {
    for (const file of [rendererCaller, 'apps/desktop/test/renderer/helpers/fakePhosphor.ts']) {
      expect(await severity(file, 'react-hooks/rules-of-hooks')).toBe(1)
      expect(await severity(file, 'react-hooks/exhaustive-deps')).toBe(1)
    }
    const code = `import { useEffect, useState } from 'react'
      export function View({ enabled, value }: { enabled: boolean; value: string }) {
        if (enabled) useState(0)
        useEffect(() => { console.log(value) }, [])
        return null
      }`
    for (const rule of ['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps']) {
      expect(await messages(code, rendererCaller, rule)).toEqual([
        expect.objectContaining({ severity: 1 }),
      ])
      expect(await severity('apps/host/src/index.ts', rule)).toBe(0)
      expect(await severity('apps/desktop/electron/preload.ts', rule)).toBe(0)
    }
  })

  it.each([
    'apps/desktop/electron/preload.ts',
    'apps/desktop/electron/pi/session-writer.test.ts',
    'apps/desktop/test/main/preload.freeze.test.ts',
    'libs/shared/src/errors.ts',
    'libs/shared/test/ipc.freeze.test.ts',
    'libs/session-runtime/src/bundled-extensions.ts',
    'libs/session-runtime/src/pi/pi-paths.test.ts',
    'libs/pi-extensions/pi-ext/context-budget.ts',
    'libs/pi-extensions/pi-ext/context-budget.test.ts',
  ])('resolves typed promise warnings for %s without missing-project failures', async (file) => {
    const code = `declare function accepts(callback: () => void): void;
      Promise.resolve('unhandled');
      accepts(async () => {});`
    for (const rule of ['no-floating-promises', 'no-misused-promises']) {
      expect(await messages(code, file, `@typescript-eslint/${rule}`)).toEqual([
        expect.objectContaining({ severity: 1 }),
      ])
    }
  })

  it.each([
    rendererCaller,
    'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
    'apps/host/src/index.ts',
    'apps/control/src/index.ts',
    'tools/scripts/test/lint-policy.test.ts',
    'apps/desktop/e2e/smoke.spec.ts',
  ])('does not enable typed linting outside main/libraries: %s', async (file) => {
    const config = await eslint.calculateConfigForFile(file)
    expect(config?.languageOptions?.parserOptions?.projectService).toBeUndefined()
    for (const rule of ['no-floating-promises', 'no-misused-promises']) {
      expect(await severity(file, `@typescript-eslint/${rule}`)).toBe(0)
    }
  })

  it.each(['window.confirm("sure?")', 'window["confirm"]("sure?")'])(
    'warns about native confirmation: %s',
    async (code) => {
      expect(await messages(code, rendererCaller, 'no-restricted-properties')).toEqual([
        expect.objectContaining({ severity: 1 }),
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
  ])('warns about raw RPC escape hatches: %s', async (code) => {
    expect(await messages(code, rendererCaller, 'phosphor/no-raw-pi-command')).toEqual([
      expect.objectContaining({ severity: 1 }),
    ])
    expect(await messages(code, renderer, 'phosphor/no-raw-pi-command')).toEqual([])
  })

  it('allows RPC wrappers and narrowly exempts test doubles, not production helpers', async () => {
    expect(
      await messages('piCall("id", {})', rendererCaller, 'phosphor/no-raw-pi-command'),
    ).toEqual([])
    for (const file of [
      'apps/desktop/src/lib/rpc.test.ts',
      'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
      'apps/desktop/electron/preload.ts',
    ]) {
      expect(await severity(file, 'phosphor/no-raw-pi-command')).toBe(0)
    }
    expect(
      await severity('apps/desktop/src/dev/mockPhosphor.ts', 'phosphor/no-raw-pi-command'),
    ).toBe(1)
  })
})
