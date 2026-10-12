import { execFile } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher'
import { getConfig } from 'app-builder-lib/out/util/config/config'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_EXTENSION_FILES,
  bundledExtensions,
} from '@phosphor/session-runtime/bundled-extensions'

const appRoot = resolve(import.meta.dirname, '../..')
const root = resolve(appRoot, '../..')
const library = join(root, 'libs/pi-extensions')
// This is the existing unpacked production inventory, including the imported
// budget and context-file helpers, the artifact store format the artifacts extension reads, and
// the optional gate. Python helpers remain source-only as before.
const shippedFiles = [
  'artifact-store.ts',
  'artifacts.ts',
  'context-breakdown.ts',
  'context-budget.ts',
  'context-files.ts',
  'headroom.ts',
  'lane-reload.ts',
  'mcp-status.ts',
  'optional/permission-gate.ts',
  'subagent-snapshot.ts',
  'tool-name-guard.ts',
  'worktree-paths.ts',
]

describe('standalone pi extension resources', () => {
  it('exports production source files without exposing tests', () => {
    const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@phosphor/pi-extensions')
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.exports).sort()).toEqual(
      shippedFiles.map((name) => `./${name.slice(0, -3)}`).sort(),
    )
    for (const file of shippedFiles) {
      expect(manifest.exports[`./${file.slice(0, -3)}`]).toEqual({
        types: `./pi-ext/${file}`,
        default: `./pi-ext/${file}`,
      })
    }
  })

  it('copies the builder inventory to resources/pi-ext and loads all seven in plain Node', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'phosphor-extension-resources-'))
    try {
      const resources = join(temporary, 'resources')
      const config = await getConfig(appRoot, null, null)
      const matchers = getFileMatchers(config, 'extraResources', resources, {
        defaultSrc: appRoot,
        globalOutDir: join(temporary, 'output'),
        customBuildOptions: {},
        macroExpander: (path) => path,
      })!
      const matcher = matchers.find((entry) => entry.to === join(resources, 'pi-ext'))!
      expect(matcher.from).toBe(join(library, 'pi-ext'))
      expect(matcher.patterns).toEqual(['**/*.ts', '!**/*.test.ts'])
      const filter = matcher.createFilter()
      const copied: string[] = []
      for (const relative of readdirSync(matcher.from, { recursive: true }).map(String)) {
        const source = join(matcher.from, relative)
        const stat = statSync(source)
        if (!stat.isFile() || !filter(source, stat)) continue
        const destination = join(matcher.to, relative)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(source, destination)
        expect(readFileSync(destination)).toEqual(readFileSync(source))
        copied.push(relative.replaceAll('\\', '/'))
      }
      expect(copied.sort()).toEqual(shippedFiles)
      const entryPoints = bundledExtensions(resources)
      expect(entryPoints.map((path) => path.slice(matcher.to.length + 1))).toEqual([
        ...BUNDLED_EXTENSION_FILES,
      ])
      const bundle = await build({
        absWorkingDir: temporary,
        entryPoints,
        nodePaths: [join(root, 'node_modules')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        outdir: 'unused',
        metafile: true,
        tsconfig: join(appRoot, 'tsconfig.node.json'),
      })
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/context-budget.ts')
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/context-files.ts')
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/artifact-store.ts')
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/subagent-snapshot.ts')
      expect(bundle.outputFiles).toHaveLength(7)
      for (const output of Object.values(bundle.metafile.outputs)) {
        expect(output.imports.filter((entry) => entry.external && !isBuiltin(entry.path))).toEqual(
          [],
        )
      }
      // Bundles can exceed Linux's per-argument limit, so execute files rather than node -e.
      for (const output of bundle.outputFiles) {
        const executable = join(temporary, `${basename(output.path, '.js')}.cjs`)
        writeFileSync(
          executable,
          `${output.text}\nprocess.stdout.write(typeof module.exports.default)`,
        )
        const { stdout } = await promisify(execFile)(process.execPath, [executable], {
          cwd: temporary,
        })
        expect(stdout).toBe('function')
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
