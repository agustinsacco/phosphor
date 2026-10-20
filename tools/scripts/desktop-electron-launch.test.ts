import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { desktopElectronLaunchOptions } from './desktop-electron-launch.mjs'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const loader = join(
  dirname(require.resolve('playwright-core/package.json')),
  'lib/server/electron/loader.js',
)
const preload = join(root, 'tools/scripts/desktop-electron-loader.cjs')

function runPreload(argv: string[]) {
  let delegatedArgv: string[] | undefined
  const context = {
    __filename: preload,
    process: { argv: [...argv] },
    require: Object.assign(
      (name: string) => {
        if (name === 'node:path') return require(name)
        expect(name).toBe(loader)
        delegatedArgv = [...context.process.argv]
      },
      { resolve: require.resolve },
    ),
  }
  runInNewContext(readFileSync(preload, 'utf8'), context, { filename: preload })
  return delegatedArgv
}

describe('Desktop Electron Playwright launcher', () => {
  it('retains the app-owned executable and preloads the installed standard loader before app args', () => {
    const args = [join(root, 'apps/desktop'), '--disable-gpu']
    const options = desktopElectronLaunchOptions(args)
    expect(options).toEqual({
      executablePath: createRequire(join(root, 'apps/desktop/package.json'))('electron'),
      args: ['-r', preload, ...args],
    })
    expect(args).toEqual([join(root, 'apps/desktop'), '--disable-gpu'])
    expect(require('playwright-core/package.json').version).toBe('1.62.1')
    expect(loader).toBe(join(root, 'node_modules/playwright-core/lib/server/electron/loader.js'))
    for (const file of ['fixtures/local-app.ts', 'startup.spec.ts', 'routines.spec.ts']) {
      const source = readFileSync(join(root, 'apps/desktop/e2e', file), 'utf8')
      expect(source).toContain('...desktopElectronLaunchOptions([')
      expect(source).not.toContain('executablePath:')
    }
    for (const file of ['capture-readme-shots.mjs', 'capture-live-shots.mjs']) {
      const source = readFileSync(join(root, 'tools/scripts', file), 'utf8')
      expect(source).toContain("...desktopElectronLaunchOptions([appRoot, '--disable-gpu'])")
      expect(source).not.toContain('executablePath:')
    }
  })

  it('removes only its exact preload pair before invoking the installed loader', () => {
    const args = [
      'electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '-r',
      preload,
      '/desktop',
      '--user-arg',
    ]
    expect(runPreload(args)).toEqual([
      'electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '/desktop',
      '--user-arg',
    ])
    expect(args).toContain(preload)
    expect(preload.startsWith(join(root, 'apps/desktop') + '/')).toBe(false)
  })

  it.each([
    ['electron', '--inspect=0', '--remote-debugging-port=0', '-r', '/unrelated.cjs', '/desktop'],
    ['electron', '--inspect=0', '--remote-debugging-port=0', '/desktop'],
  ])('preserves unrelated preloads and already-consumed or absent pairs: %j', (...argv) => {
    expect(runPreload(argv)).toEqual(argv)
  })

  it.each([
    ['electron', preload, '/desktop'],
    ['electron', '-r', preload, '/desktop', preload],
  ])('rejects unexpected self-path layouts rather than discarding arguments: %j', (...argv) => {
    expect(() => runPreload(argv)).toThrow('Unexpected Desktop Electron preload argv layout')
  })

  it('uses the installed loader screenshot switches and readiness handshake without copying them', async () => {
    const switches = new Map<string, string>()
    const emitted: string[] = []
    const app = {
      commandLine: {
        appendSwitch: (name: string, value: string) => switches.set(name, value),
      },
      whenReady: () => Promise.resolve('ready'),
      isReady: () => true,
      emit: (event: string) => {
        emitted.push(event)
        return true
      },
      listenerCount: () => 1,
    }
    const context = {
      require: (name: string) => {
        expect(name).toBe('electron')
        return { app }
      },
      process: {
        argv: ['electron', '--inspect=0', '--remote-debugging-port=0', '/desktop'],
        env: {},
      },
      __playwright_run: undefined as undefined | (() => Promise<void>),
    }
    runInNewContext(readFileSync(loader, 'utf8'), context, { filename: loader })
    expect(context.process.argv).toEqual(['electron', '/desktop'])
    expect(switches.get('enable-features')).toBe('CDPScreenshotNewSurface')
    expect(switches.has('disable-background-timer-throttling')).toBe(true)
    expect(switches.has('disable-renderer-backgrounding')).toBe(true)
    expect(app.isReady()).toBe(false)
    expect(app.emit('ready')).toBe(true)
    expect(emitted).toEqual([])
    const ready = app.whenReady()
    expect(context.__playwright_run).toBeTypeOf('function')
    await context.__playwright_run!()
    expect(await ready).toBe('ready')
    expect(app.isReady()).toBe(true)
    expect(emitted).toEqual(['ready'])
  })

  it('collects failure artifacts from the app-owned Playwright configuration paths', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    const upload = workflow.slice(workflow.indexOf('name: playwright-report-${{ matrix.os }}'))
    expect(upload).toContain('apps/desktop/playwright-report/')
    expect(upload).toContain('apps/desktop/test-results/')
    expect(upload).not.toMatch(/^\s+(playwright-report|test-results)\/$/m)
  })
})
