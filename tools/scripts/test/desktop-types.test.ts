import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../../..')
const projects = ['node', 'web', 'e2e', 'tests'] as const
type Project = (typeof projects)[number]
const strictness = [
  'strict',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'forceConsistentCasingInFileNames',
  'noEmit',
] as const

const toRepoPath = (root: string, file: string) => relative(root, file).replaceAll('\\', '/')

function parseProject(root: string, project: Project): ts.ParsedCommandLine {
  const file = join(root, 'apps/desktop', `tsconfig.${project}.json`)
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile)
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(file), undefined, file)
  expect(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  return parsed
}

function owners(root: string): Map<string, Project[]> {
  const byFile = new Map<string, Project[]>()
  for (const project of projects) {
    for (const file of parseProject(root, project).fileNames) {
      const path = toRepoPath(root, file)
      byFile.set(path, [...(byFile.get(path) ?? []), project])
    }
  }
  return byFile
}

/** JavaScript the project's program loads outside node_modules. */
function loadedJs(project: Project): string[] {
  const parsed = parseProject(repo, project)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  return program
    .getSourceFiles()
    .map((source) => toRepoPath(repo, source.fileName))
    .filter((path) => /\.[cm]?jsx?$/.test(path) && !path.split('/').includes('node_modules'))
    .sort()
}

describe('Desktop TypeScript projects', () => {
  it('put every tracked Desktop TS file in a typechecked project', () => {
    // Without pathspec magic, git's `*` also matches `/`, so these reach every depth.
    const patterns = ['ts', 'tsx', 'mts', 'cts'].map((ext) => `apps/desktop/*.${ext}`)
    const tracked = execFileSync('git', ['ls-files', '-z', '--', ...patterns], {
      cwd: repo,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
    const covered = owners(repo)
    expect(tracked).toContain('apps/desktop/e2e/fixtures/remote-host.ts')
    expect(tracked.filter((file) => !covered.has(file))).toEqual([])
  })

  it('typecheck both build configs, the Playwright config and the e2e fixtures', () => {
    const covered = owners(repo)
    expect(covered.get('apps/desktop/vite.config.ts')).toEqual(['web'])
    expect(covered.get('apps/desktop/electron.vite.config.ts')).toEqual(['node'])
    expect(covered.get('apps/desktop/playwright.config.ts')).toEqual(['e2e'])
    expect(covered.get('apps/desktop/e2e/fixtures/remote-host.ts')).toEqual(['e2e'])
    expect(covered.get('apps/desktop/e2e/fixtures/ws-receiver.d.ts')).toEqual(['e2e'])
    expect(covered.get('apps/desktop/e2e/smoke.spec.ts')).toEqual(['e2e'])
    // The renderer's window.phosphor declaration, used inside page.evaluate.
    expect(covered.get('libs/shared/src/ipc.ts')).toContain('e2e')
    expect(covered.get('apps/desktop/package-boundary.test.ts')).toEqual(['tests'])
    expect(covered.get('apps/desktop/scripts/__tests__/adhoc-sign-mac.test.ts')).toEqual(['tests'])
  })

  it('keep the base compiler strictness in every project', () => {
    for (const project of projects) {
      const { options } = parseProject(repo, project)
      for (const flag of strictness)
        expect([project, flag, options[flag]]).toEqual([project, flag, true])
      expect([project, options.checkJs]).toEqual([project, undefined])
    }
  })

  it('give each test layout to the project that owns its subject, exactly once', () => {
    const expected: Record<string, Project> = {
      'apps/desktop/electron/nested/session.test.ts': 'node',
      'apps/desktop/test/main/nested/session.test.ts': 'node',
      'apps/desktop/test/main/__fixtures__/session.ts': 'node',
      'apps/desktop/src/nested/store.test.ts': 'web',
      'apps/desktop/src/nested/view.test.tsx': 'web',
      'apps/desktop/test/renderer/nested/store.test.ts': 'web',
      'apps/desktop/test/renderer/nested/view.test.tsx': 'web',
      'apps/desktop/test/renderer/__fixtures__/session.ts': 'web',
      'apps/desktop/package-boundary.test.ts': 'tests',
      'apps/desktop/scripts/__tests__/sign.test.ts': 'tests',
      'apps/desktop/test/package-boundary.test.ts': 'tests',
      'apps/desktop/test/playwright-config.test.ts': 'tests',
      'apps/desktop/test/scripts/sign.test.ts': 'tests',
      'apps/desktop/e2e/session.spec.ts': 'e2e',
      'apps/desktop/e2e/fixtures/session.ts': 'e2e',
      'apps/desktop/test/e2e/global-setup.test.ts': 'e2e',
      'apps/desktop/test/e2e/fixtures/pi-stub/session.test.ts': 'e2e',
      'apps/desktop/vite.config.ts': 'web',
      'apps/desktop/electron.vite.config.ts': 'node',
      'apps/desktop/playwright.config.ts': 'e2e',
    }
    const root = mkdtempSync(join(tmpdir(), 'phosphor-desktop-types-'))
    try {
      copyFileSync(join(repo, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'))
      mkdirSync(join(root, 'apps/desktop'), { recursive: true })
      for (const project of projects) {
        const config = `apps/desktop/tsconfig.${project}.json`
        copyFileSync(join(repo, config), join(root, config))
      }
      for (const path of Object.keys(expected)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), 'export {}\n')
      }
      const found = Object.fromEntries(owners(root))
      expect(found).toEqual(
        Object.fromEntries(Object.entries(expected).map(([path, project]) => [path, [project]])),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('load only the imported .mjs helpers as JavaScript, unchecked', { timeout: 60_000 }, () => {
    expect(loadedJs('e2e')).toEqual(['tools/scripts/desktop-electron-launch.mjs'])
    expect(loadedJs('tests')).toEqual(['apps/desktop/scripts/adhoc-sign-mac.mjs'])
    for (const project of ['e2e', 'tests'] as const) {
      for (const file of parseProject(repo, project).fileNames) expect(file).toMatch(/\.tsx?$/)
    }
  })

  it('reject an e2e fixture whose host-protocol frame drifted', { timeout: 60_000 }, () => {
    const { options } = parseProject(repo, 'e2e')
    // The compiler host sees '/'-separated paths on every platform.
    const fixtures = join(repo, 'apps/desktop/e2e/fixtures').replaceAll('\\', '/')
    const header = "import type { ClientFrame } from '../../../../libs/shared/src/host-protocol'\n"
    const virtual = new Map([
      [
        `${fixtures}/frame-current.ts`,
        `${header}export const frame: ClientFrame = { type: 'ping', at: 1 }\n`,
      ],
      [
        `${fixtures}/frame-drifted.ts`,
        `${header}export const frame: ClientFrame = { type: 'ping', at: '1' }\n`,
      ],
    ])
    const host = ts.createCompilerHost(options)
    const { getSourceFile, fileExists, readFile } = host
    host.fileExists = (file) => virtual.has(file) || fileExists.call(host, file)
    host.readFile = (file) => virtual.get(file) ?? readFile.call(host, file)
    host.getSourceFile = (file, language, onError, create) => {
      const text = virtual.get(file)
      return text === undefined
        ? getSourceFile.call(host, file, language, onError, create)
        : ts.createSourceFile(file, text, language)
    }
    const program = ts.createProgram({ rootNames: [...virtual.keys()], options, host })
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file ? toRepoPath(repo, d.file.fileName) : 'global'} TS${d.code}`)
    expect(errors).toEqual(['apps/desktop/e2e/fixtures/frame-drifted.ts TS2322'])
  })
})
