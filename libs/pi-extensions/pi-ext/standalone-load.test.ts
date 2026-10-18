import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_EXTENSION_FILES } from '../../session-runtime/src/bundled-extensions'

const source = import.meta.dirname
const require = createRequire(import.meta.url)

async function registerCopied(file: string, singleFile = false) {
  const stage = mkdtempSync(join(tmpdir(), 'phosphor-pi-load-'))
  try {
    const files = singleFile ? [file] : readdirSync(source, { recursive: true }).map(String)
    for (const name of files) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const from = join(source, name)
      if (!statSync(from).isFile()) continue
      const to = join(stage, singleFile ? basename(name) : name)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
    if (singleFile) expect(readdirSync(stage, { recursive: true })).toEqual([basename(file)])
    const result = await build({
      entryPoints: [join(stage, singleFile ? basename(file) : file)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['typebox'],
      tsconfigRaw: { compilerOptions: { paths: {} } },
      write: false,
    })
    const module = { exports: {} as { default?: (pi: object) => void } }
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
      require,
      module,
      module.exports,
    )
    expect(module.exports.default).toBeTypeOf('function')
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      setModel: vi.fn(),
    }
    module.exports.default!(pi)
    return {
      events: pi.on.mock.calls.map(([event]) => event),
      commands: pi.registerCommand.mock.calls.map(([name]) => name),
      tools: pi.registerTool.mock.calls.map(([tool]) => tool.name),
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('standalone extension registration', () => {
  it.each(BUNDLED_EXTENSION_FILES)(
    'registers %s independently from staged siblings',
    async (file) => {
      vi.stubEnv('PHOSPHOR_HEADROOM_URL', 'http://127.0.0.1:1')
      const registered = await registerCopied(file)
      expect(registered.events.length).toBeGreaterThan(0)
      if (file === 'artifacts.ts') {
        expect(registered.tools).toEqual([
          'artifact_help',
          'artifact_create',
          'artifact_edit',
          'artifact_update',
          'artifact_read',
          'artifact_list',
        ])
        expect(registered.commands).toEqual(['phosphor-save-subagent-snapshot'])
      }
      if (file === 'context-breakdown.ts') {
        expect(registered.commands).toEqual([
          'phosphor-context-budget',
          'phosphor-context-files',
          'phosphor-swarm',
        ])
      }
      if (file === 'lane-reload.ts') expect(registered.commands).toEqual(['phosphor-reload'])
    },
  )

  it('registers the optional gate from one copied file without siblings', async () => {
    expect(await registerCopied('optional/permission-gate.ts', true)).toEqual({
      events: ['tool_call'],
      commands: [],
      tools: [],
    })
  })
})
