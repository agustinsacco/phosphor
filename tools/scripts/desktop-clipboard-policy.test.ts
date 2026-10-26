import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

async function config(ci = '', optIn = '') {
  vi.stubEnv('CI', ci)
  vi.stubEnv('PHOSPHOR_E2E_CLIPBOARD', optIn)
  vi.resetModules()
  return (await import('../../apps/desktop/playwright.config')).default
}

afterEach(() => vi.unstubAllEnvs())

it('excludes system-clipboard tests locally, even when their title is explicitly selected', async () => {
  expect((await config()).grepInvert).toEqual(/@system-clipboard/)
})

it('keeps native clipboard coverage in CI and behind an explicit local opt-in', async () => {
  expect((await config('1')).grepInvert).toBeUndefined()
  expect((await config('', '1')).grepInvert).toBeUndefined()
  expect((await config('', '0')).grepInvert).toEqual(/@system-clipboard/)
})

it('tags every Desktop test that currently exercises the real clipboard', () => {
  const titles = {
    'smoke.spec.ts': [
      'Mermaid viewer fits, zooms, pans, exports and restores focus',
      'text fields get a right-click menu, and composers learn autocomplete',
      'explorer copies, cuts, multi-drags and imports disk-backed files',
      'dropped chat images open on click and copy on right-click',
      'annotating a pasted image replaces it by default, or keeps both',
      'terminal pane spawns a real shell, and reopening replays its scrollback',
    ],
    'remote-lanes.spec.ts': ['Remote row menu is complete, gated and durable'],
    'machines.spec.ts': ['onboarding uses one terminal command and keeps Online and Providers'],
  }
  for (const [file, names] of Object.entries(titles)) {
    const path = resolve(root, 'apps/desktop/e2e', file)
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const tests = ast.statements.flatMap((node) => {
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return []
      const call = node.expression
      if (call.expression.getText(ast) !== 'test') return []
      const title = call.arguments[0]
      return title && ts.isStringLiteral(title) ? [{ title: title.text, call }] : []
    })
    for (const name of names) {
      const test = tests.find(({ title }) => title.startsWith(name))
      expect(test, `${file}: ${name}`).toBeDefined()
      // Other tags (such as @macos) may follow; nothing else may.
      expect(test!.title.slice(name.length), `${file}: ${name}`).toMatch(
        /^ @system-clipboard(?: @[\w-]+)*$/,
      )
    }
  }
})
