import { readFileSync, lstatSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import type { Configuration, PlatformSpecificBuildOptions } from 'app-builder-lib'
import { getConfig } from 'app-builder-lib/out/util/config/config'
import { expandMacro } from 'app-builder-lib/out/util/macroExpander'
import { describe, expect, it } from 'vitest'

const app = import.meta.dirname
const root = resolve(app, '../..')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const manifest = json(join(app, 'package.json'))
const facade = json(join(root, 'package.json'))

describe('Desktop application and native install boundary', () => {
  it('keeps app identity and main/preload output contracts in the application directory', async () => {
    expect(manifest).toMatchObject({
      name: 'phosphor',
      version: '0.1.0',
      type: 'module',
      main: 'out/main/main.js',
      private: true,
    })
    const config = await getConfig(app, null, null)
    expect(config.appId).toBe('works.phosphor.app')
    expect(config.productName).toBe('Phosphor')
    expect(config.directories).toMatchObject({ buildResources: 'build', output: 'release' })
    expect(config.files).toEqual([
      {
        filter: [
          'out/**',
          'package.json',
          '!**/*.map',
          '!**/node_modules/onnxruntime-web{,/**}',
          '!**/node_modules/@img/sharp-wasm32{,/**}',
        ],
      },
    ])
    expect(config.extraResources).toContainEqual({
      from: '../../libs/pi-extensions/skills',
      to: 'skills',
      filter: ['**/*.md'],
    })
    expect(config.asarUnpack).toEqual([
      '**/node_modules/node-pty/**',
      '**/node_modules/onnxruntime-node/bin/**',
      '**/node_modules/@img/**',
    ])
    expect(config.npmRebuild).toBe(true)
    expect(config.afterPack).toBe('scripts/adhoc-sign-mac.mjs')
    expect(config.mac?.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ])
    expect(config.win?.artifactName).toBe('${productName}-${version}-${arch}.${ext}')
    expect(config.nsis).toMatchObject({ perMachine: false, deleteAppDataOnUninstall: false })
    expect(config.publish).toEqual({ provider: 'github', releaseType: 'draft' })
    const vite = readFileSync(join(app, 'electron.vite.config.ts'), 'utf8')
    // out/main/main.js (the manifest's `main`) and the voice utility process beside it.
    expect(vite).toContain("main: 'electron/main.ts'")
    expect(vite).toContain("'voice-worker': 'electron/voice/worker.ts'")
    expect(vite).toContain("'brain-embedding-worker': 'electron/brain/embedding-worker.ts'")
    expect(vite).toContain("lib: { entry: 'electron/preload.ts' }")
    expect(vite).toContain("format: 'cjs'")
    expect(vite).toContain("entryFileNames: '[name].cjs'")
    const main = readFileSync(join(app, 'electron/main.ts'), 'utf8')
    expect(main).toContain("'../preload/preload.cjs'")
    expect(main).toContain("'../renderer/index.html'")
  })

  it('owns Electron and node-pty without a root native install or recursive lifecycle', () => {
    expect(facade.main).toBeUndefined()
    expect(facade.dependencies['node-pty']).toBeUndefined()
    for (const dependency of [
      'electron',
      'electron-builder',
      'electron-vite',
      '@electron/rebuild',
    ]) {
      expect(facade.devDependencies[dependency]).toBeUndefined()
      expect(manifest.devDependencies[dependency]).toBeDefined()
    }
    expect(facade.scripts.postinstall).toBe(
      'npm ci --prefix apps/desktop && npm ci --prefix apps/control && npm ci --prefix apps/web',
    )
    expect(manifest.scripts.postinstall).toBe(
      'install-electron && electron-builder install-app-deps && node ../../tools/scripts/fix-node-pty.mjs',
    )
    expect(manifest.scripts.rebuild).toBe(
      'electron-rebuild -f -w node-pty && node ../../tools/scripts/fix-node-pty.mjs',
    )
    expect(existsSync(join(root, 'node_modules/node-pty'))).toBe(false)
    expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(app, 'node_modules')).isSymbolicLink()).toBe(false)
    // Filesystem-only check must precede any lazy Electron executable lookup.
    const electron = join(app, 'node_modules/electron')
    const executable = readFileSync(join(electron, 'path.txt'), 'utf8').trim()
    const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>
    }
    expect(readFileSync(join(electron, 'dist/version'), 'utf8').trim()).toBe(
      lock.packages['node_modules/electron']?.version,
    )
    expect(lstatSync(join(electron, 'dist', executable)).isFile()).toBe(true)
    const require = createRequire(join(app, 'package.json'))
    for (const dependency of ['electron', 'node-pty']) {
      expect(require.resolve(`${dependency}/package.json`)).toBe(
        join(app, 'node_modules', dependency, 'package.json'),
      )
    }
    for (const file of ['fixtures/local-app.ts', 'startup.spec.ts', 'routines.spec.ts']) {
      expect(readFileSync(join(app, 'e2e', file), 'utf8')).toContain(
        '...desktopElectronLaunchOptions([',
      )
    }
    expect(readFileSync(join(root, 'tools/scripts/fix-node-pty.mjs'), 'utf8')).toContain(
      "new URL('../../apps/desktop/package.json', import.meta.url)",
    )
  })

  it('resolves esbuild from declared root tooling, never an ancestor checkout', () => {
    expect(facade.devDependencies.esbuild).toBe('0.25.12')
    const require = createRequire(join(root, 'package.json'))
    const path = require.resolve('esbuild/package.json')
    expect(path).toBe(join(root, 'node_modules/esbuild/package.json'))
    expect(json(path).version).toBe('0.25.12')
    expect(lstatSync(join(root, 'node_modules/esbuild')).isSymbolicLink()).toBe(false)
    const viteRequire = createRequire(require.resolve('vite/package.json'))
    expect(viteRequire.resolve('esbuild/package.json')).toBe(
      join(root, 'node_modules/vite/node_modules/esbuild/package.json'),
    )
    expect(viteRequire('esbuild/package.json').version).toBe('0.28.1')
  })

  it('anchors relocated tooling to the workspace or application cwd', () => {
    for (const file of [
      'pi-live-smoke.mjs',
      'capture-live-shots.mjs',
      'capture-readme-shots.mjs',
      'generate-icons.mjs',
    ]) {
      expect(readFileSync(join(root, 'tools/scripts', file), 'utf8')).toContain(
        "join(dirname(fileURLToPath(import.meta.url)), '../..')",
      )
    }
    expect(readFileSync(join(root, 'tools/scripts/perf/stream-buffers.mjs'), 'utf8')).toContain(
      'new URL(`../../../${path}`',
    )
    expect(readFileSync(join(root, 'tools/scripts/e2e.sh'), 'utf8')).toContain(
      'cd "$(dirname "$0")/../../apps/desktop"',
    )
    expect(readFileSync(join(root, 'tools/scripts/validate.sh'), 'utf8')).toContain(
      'cd "$(dirname "$0")/../.."',
    )
  })

  it('keeps root npm aliases and browser dependency resolution on the Desktop boundary', () => {
    for (const command of [
      'dev',
      'dev:web',
      'build',
      'preview',
      'pack',
      'dist',
      'dist:mac',
      'dist:linux',
      'dist:win',
      'test:e2e',
    ]) {
      expect(facade.scripts[command]).toBe(`npm run ${command} --prefix apps/desktop --`)
      expect(manifest.scripts[command]).toBeDefined()
    }
    // Root typecheck covers every project (FD-04); Desktop keeps its own script.
    expect(facade.scripts.typecheck).toBe('node tools/scripts/typecheck.mjs')
    expect(manifest.scripts.typecheck).toBeDefined()
    for (const file of ['electron.vite.config.ts', 'vite.config.ts']) {
      const config = readFileSync(join(app, file), 'utf8')
      expect(config).toContain("dedupe: ['react', 'react-dom', 'zustand', 'luxon', 'cron-parser']")
      expect(config).toContain("'@': resolve(import.meta.dirname, '../../libs/client-ui/src')")
      expect(config).toContain(
        "'@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src')",
      )
    }
  })
})

type Filter = (file: string, stat: object) => boolean
/** electron-builder's own node_modules matcher (internal; not in its typings). */
const { getNodeModuleFileMatcher } = createRequire(join(app, 'package.json'))(
  'app-builder-lib/out/fileMatcher',
) as {
  getNodeModuleFileMatcher(
    appDir: string,
    destination: string,
    expand: (pattern: string) => string,
    options: PlatformSpecificBuildOptions,
    packager: { config: Configuration; debugLogger: { isEnabled: boolean } },
  ): FileMatcher
}
const file = (path: string) => ({ isDirectory: () => false, moduleFullFilePath: path })
const ORT = 'node_modules/onnxruntime-node/bin/napi-v6'

describe('Brain resources and native packaging', () => {
  it('ships the standalone Brain bundles and never the raw Brain sources', async () => {
    const config = await getConfig(app, null, null)
    const piExt = {
      from: '../../libs/pi-extensions/pi-ext',
      to: 'pi-ext',
      filter: ['**/*.ts', '!**/*.test.ts', '!brain.ts', '!brain-processor.ts'],
    }
    expect(config.extraResources).toContainEqual(piExt)
    expect(config.extraResources).toContainEqual({
      from: '../../libs/pi-extensions/brain-ext',
      to: 'brain-ext',
      filter: ['brain.mjs', 'brain-processor.mjs'],
    })
    expect(config.extraResources).toContainEqual({
      from: 'build/brain-third-party-notices.md',
      to: 'brain-third-party-notices.md',
    })
    const dir = join(root, 'libs/pi-extensions/pi-ext')
    const copies = new FileMatcher(dir, '/dest', (p) => p, piExt.filter).createFilter() as Filter
    const kept = (name: string) => copies(join(dir, name), file(name))
    expect(['artifacts.ts', 'brain.ts', 'brain-processor.ts', 'brain.test.ts'].map(kept)).toEqual([
      true,
      false,
      false,
      false,
    ])
    expect(kept('optional/brain.ts')).toBe(true)
  })

  it('bundles the extensions in every main build without a runtime import', () => {
    const vite = readFileSync(join(app, 'electron.vite.config.ts'), 'utf8')
    expect(vite).toContain('tools/scripts/build-brain-extensions.mjs')
    expect(vite).toContain('libs/pi-extensions/brain-ext')
    expect(readFileSync(join(app, 'electron/main.ts'), 'utf8')).not.toContain('brain-ext')
  })

  it.each([
    ['mac', 'arm64', `${ORT}/darwin/arm64/libonnxruntime.1.dylib`, `${ORT}/darwin/x64/x.node`],
    ['mac', 'x64', `${ORT}/darwin/x64/x.node`, `${ORT}/darwin/arm64/libonnxruntime.1.dylib`],
    ['linux', 'x64', `${ORT}/linux/x64/libonnxruntime.so.1`, `${ORT}/linux/arm64/x.node`],
    ['linux', 'arm64', `${ORT}/linux/arm64/x.node`, `${ORT}/linux/x64/libonnxruntime.so.1`],
    ['win', 'x64', `${ORT}/win32/x64/DirectML.dll`, `${ORT}/win32/arm64/onnxruntime.dll`],
  ] as const)('packs only the %s-%s ONNX Runtime binary', async (os, arch, own, other) => {
    const config = await getConfig(app, null, null)
    const matcher = getNodeModuleFileMatcher(
      app,
      '/dest',
      (pattern) => expandMacro(pattern, arch, {} as never),
      config[os] ?? {},
      { config, debugLogger: { isEnabled: false } },
    )
    const filter = matcher.createFilter() as Filter
    const packs = (path: string) => filter('/elsewhere', file(path))
    const foreign = ['darwin', 'linux', 'win32'].filter((name) => !own.includes(`/${name}/`))
    expect(packs(own)).toBe(true)
    expect(packs(other)).toBe(false)
    for (const name of foreign) expect(packs(`${ORT}/${name}/${arch}/x.node`)).toBe(false)
    // No web/WASM fallback ships; licences and the Node entry points do.
    expect(packs('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')).toBe(false)
    expect(packs('node_modules/@img/sharp-wasm32/lib/sharp-wasm32.node.wasm')).toBe(false)
    for (const kept of [
      'node_modules/@huggingface/transformers/LICENSE',
      'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
      'node_modules/@huggingface/tokenizers/LICENSE',
      'node_modules/onnxruntime-node/dist/index.js',
      'node_modules/sharp/LICENSE',
      'node_modules/@img/sharp-darwin-arm64/LICENSE',
      'node_modules/node-pty/lib/index.js',
    ])
      expect(packs(kept)).toBe(true)
  })
})
