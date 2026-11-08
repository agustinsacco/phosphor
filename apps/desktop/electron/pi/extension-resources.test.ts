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
// budget, context-file and global-instructions helpers, the artifact store format the artifacts extension reads, and
// the optional gate, the dependency-free status/widget key vocabulary, and the set
// pi-subagents children load. Python helpers remain source-only as before.
// The release-* helpers are release-manager's lease, GitHub, guard, hooks, prompt, status and tools.
const shippedFiles = [
  'artifact-store.ts',
  'artifacts.ts',
  'context-breakdown.ts',
  'context-budget.ts',
  'context-files.ts',
  'global-context.ts',
  'headroom.ts',
  'lane-reload.ts',
  'main-checkout.ts',
  'message-ledger.ts',
  'optional/permission-gate.ts',
  'pi-api.ts',
  'release-github.ts',
  'release-guard.ts',
  'release-hooks.ts',
  'release-lease.ts',
  'release-manager.ts',
  'release-prompt.ts',
  'release-status.ts',
  'release-tools.ts',
  'status-keys.ts',
  'subagent-children.ts',
  'subagent-snapshot.ts',
  'swarm.ts',
  'tool-name-guard.ts',
  'worktree-paths.ts',
]
// Exported for source, build and test consumers; packaged resources carry only
// their standalone bundles (brain-ext/), never these TypeScript sources.
const bundleOnlySources = [
  'brain.ts',
  'brain-processor.ts',
  'brain-learning.ts',
  'brain-learning-context.ts',
  'brain-learning-result.ts',
  'brain-learning-provenance.ts',
  'brain-learning-carrier.ts',
  'brain-learning-carrier-auth.ts',
  'brain-learning-carrier-files.ts',
  'brain-learning-carrier-operation.ts',
  'brain-learning-carrier-sdk.ts',
]

describe('standalone pi extension resources', () => {
  it('exports production source files without exposing tests', () => {
    const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@phosphor/pi-extensions')
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [...shippedFiles, ...bundleOnlySources].map((name) => `./${name.slice(0, -3)}`).sort(),
    )
    for (const file of [...shippedFiles, ...bundleOnlySources]) {
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
      expect(matcher.patterns).toEqual(['**/*.ts', '!**/*.test.ts', '!brain*.ts'])
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
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/swarm.ts')
      expect(Object.keys(bundle.metafile.inputs)).toContain('resources/pi-ext/message-ledger.ts')
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
