import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fixture } from './__fixtures__/release'
import { atomicRecord } from './files'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

it.each(['update', 'rollback', 'uninstall'] as const)(
  'handles a real signal during synchronous %s publication without claiming success',
  (command) => {
    const f = fixture()
    fixtures.push(f)
    f.release()
    f.install('0.9.0')
    atomicRecord(join(f.lib, 'install.json'), { current: '1.0.0', previous: '0.9.0' }, 0o644)
    const entry = join(f.home, 'signal-test.mjs')
    const buildOptions = {
      stdin: {
        resolveDir: resolve('.'),
        contents: `
          import fs from 'node:fs'
          import { syncBuiltinESMExports } from 'node:module'
          import { runUpdate } from './apps/host/src/commands/update'
          import { runUninstall } from './apps/host/src/commands/uninstall'
          const context = ${JSON.stringify({ ...f.context, service: undefined })}
          context.print = (line) => console.log(line)
          context.service = { runner: async () => ({ code: 3, stdout: '', stderr: '' }) }
          const command = ${JSON.stringify(command)}
          const method = command === 'uninstall' ? 'rmdirSync' : 'renameSync'
          const original = fs[method]
          fs[method] = (...args) => {
            const result = original(...args)
            const target = command === 'uninstall' ? args[0] : args[1]
            if (target === ${JSON.stringify(join(f.lib, command === 'uninstall' ? '' : 'current'))}) {
              process.kill(process.pid, command === 'uninstall' ? 'SIGTERM' : 'SIGINT')
              // Hold the synchronous section while the OS queues the signal.
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
            }
            return result
          }
          syncBuiltinESMExports()
          process.exitCode = command === 'uninstall'
            ? await runUninstall(context)
            : await runUpdate(context, { rollback: command === 'rollback' })
        `,
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      tsconfigRaw: { compilerOptions: { paths: { '@shared/*': ['./libs/shared/src/*'] } } },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    }
    execFileSync(
      process.execPath,
      ['-e', `require('esbuild').buildSync(${JSON.stringify(buildOptions)})`],
      { stdio: 'pipe' },
    )
    // Only this isolated child ever receives an OS signal. No service binaries run.
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(command === 'uninstall' ? 143 : 130)
    expect(result.stdout).not.toMatch(/Selected Host|Host uninstalled\.|restart phosphor run/)
    if (command === 'uninstall') {
      expect(existsSync(f.lib)).toBe(false)
      expect(existsSync(join(f.home, '.local/bin/phosphor'))).toBe(false)
    } else {
      const version = command === 'rollback' ? '0.9.0' : '1.2.3'
      expect(readlinkSync(join(f.lib, 'current'))).toBe(`versions/${version}`)
      expect(JSON.parse(readFileSync(join(f.lib, 'install.json'), 'utf8'))).toEqual({
        current: version,
        previous: '1.0.0',
      })
      expect(readdirSync(f.lib).some((name) => /^\.(staging-|install-lock)/.test(name))).toBe(false)
    }
  },
)
