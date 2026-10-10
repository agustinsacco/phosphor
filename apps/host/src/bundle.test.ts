import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUNDLED_EXTENSION_FILES } from '@phosphor/session-runtime/bundled-extensions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from './__fixtures__/machine'

const BUILD = resolve(import.meta.dirname, '../scripts/build.mjs')
const SHA = 'a'.repeat(40)

let dir: string
let out: string
let machine: FakeMachine

beforeAll(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-bundle-'))
  out = join(dir, 'dist')
  const built = spawnSync(process.execPath, [BUILD, '--out', out, '--sha', SHA], {
    encoding: 'utf8',
  })
  expect(built.status, built.stderr).toBe(0)
  machine = fakeMachine()
  // No resourceRoot: the bundle finds pi-ext/ beside itself.
  const { resourceRoot: _, ...config } = machine.config
  machine.writeConfig(config)
})
afterAll(() => {
  machine?.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

/** The built file under a minimal environment, as a service manager or `env -i` would start it. */
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(out, 'phosphor.mjs'), ...args], {
    encoding: 'utf8',
    env: { HOME: machine.home, USER: 'tester', LOGNAME: 'tester', PATH: '/usr/bin:/bin', ...env },
  })
}

describe('the Host bundle', () => {
  it('lists every file it ships in BUILD-INFO.json, with its size and sha256', () => {
    const info = JSON.parse(readFileSync(join(out, 'BUILD-INFO.json'), 'utf8'))
    expect(info).toMatchObject({
      schema: 1,
      name: 'phosphor',
      version: '0.0.0-dev.aaaaaaa',
      sourceSha: SHA,
      nodeTarget: 'node22',
      entry: 'phosphor.mjs',
    })
    const onDisk = readdirSync(out, { recursive: true, encoding: 'utf8' })
      .filter((file) => file !== 'BUILD-INFO.json' && statSync(join(out, file)).isFile())
      .sort()
    expect(info.files.map((file: { path: string }) => file.path)).toEqual(onDisk)
    for (const file of info.files) {
      const bytes = readFileSync(join(out, file.path))
      expect(file.bytes, file.path).toBe(bytes.length)
      expect(file.sha256, file.path).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('imports nothing but Node builtins', () => {
    const source = readFileSync(join(out, 'phosphor.mjs'), 'utf8')
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([])
    expect(source).not.toMatch(/electron|node-pty|apps\/desktop/)
  })

  it('carries the six extensions and their helpers, and no tests', () => {
    const files = readdirSync(join(out, 'pi-ext'), { recursive: true, encoding: 'utf8' })
    for (const extension of BUNDLED_EXTENSION_FILES) expect(files).toContain(extension)
    expect(files.filter((file) => !statSync(join(out, 'pi-ext', file)).isDirectory())).toEqual(
      files.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts')),
    )
  })

  it('replaces an earlier build through a folder beside it, leaving nothing else', () => {
    const again = join(dir, 'again')
    cpSync(out, again, { recursive: true })
    const built = spawnSync(process.execPath, [BUILD, '--out', again, '--sha', SHA], {
      encoding: 'utf8',
    })
    expect(built.status, built.stderr).toBe(0)
    expect(readFileSync(join(again, 'BUILD-INFO.json'), 'utf8')).toBe(
      readFileSync(join(out, 'BUILD-INFO.json'), 'utf8'),
    )
    expect(readdirSync(dir).filter((name) => name.startsWith('.phosphor-build-'))).toEqual([])
  })

  it.each([
    ['holds no marker', () => {}, 'holds no BUILD-INFO.json file'],
    [
      'holds an empty marker',
      (at: string) => writeFileSync(join(at, 'BUILD-INFO.json'), ''),
      'holds a BUILD-INFO.json that is not JSON',
    ],
    [
      'holds a marker folder',
      (at: string) => mkdirSync(join(at, 'BUILD-INFO.json')),
      'holds no BUILD-INFO.json file',
    ],
    [
      "holds another tool's manifest",
      (at: string) =>
        writeFileSync(
          join(at, 'BUILD-INFO.json'),
          JSON.stringify({ schema: 1, name: 'other', files: [] }),
        ),
      "holds a BUILD-INFO.json that is not this Host's",
    ],
    [
      'holds a file its build did not list',
      (at: string) => cpSync(out, at, { recursive: true }),
      'holds keep.txt, which its BUILD-INFO.json does not list',
    ],
    [
      'holds a link',
      (at: string) => {
        cpSync(out, at, { recursive: true })
        symlinkSync(machine.configPath, join(at, 'pi-ext', 'linked.ts'))
      },
      'holds a link, pi-ext/linked.ts',
    ],
  ])('refuses to replace a folder that %s, and leaves it as it was', (_, arrange, refusal) => {
    const at = mkdtempSync(join(dir, 'other-'))
    writeFileSync(join(at, 'keep.txt'), 'keep')
    arrange(at)
    const before = readdirSync(at, { recursive: true, encoding: 'utf8' }).sort()
    const built = spawnSync(process.execPath, [BUILD, '--out', at], { encoding: 'utf8' })
    expect(built.status).toBe(1)
    expect(built.stderr).toContain(`${refusal}: refusing to replace it`)
    expect(readdirSync(at, { recursive: true, encoding: 'utf8' }).sort()).toEqual(before)
    expect(readFileSync(join(at, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses to replace a file', () => {
    const built = spawnSync(process.execPath, [BUILD, '--out', machine.configPath], {
      encoding: 'utf8',
    })
    expect(built.status).toBe(1)
    expect(built.stderr).toContain('is not a folder: refusing to replace it')
    expect(statSync(machine.configPath).isFile()).toBe(true)
  })

  it('reports the stamped version', () => {
    const result = run(['version', '--json'])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      hostVersion: '0.0.0-dev.aaaaaaa',
      sourceSha: SHA,
    })
  })

  it('runs doctor with a minimal environment, on the extensions beside it, and prints no secret', () => {
    const result = run(['doctor', '--json', '--config', machine.configPath], {
      ANTHROPIC_API_KEY: SECRET,
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.ok).toBe(true)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'extensions', status: 'pass' }),
    )
    expect(
      report.checks.find((check: { id: string }) => check.id === 'extensions').summary,
    ).toContain(join(out, 'pi-ext'))
    expect(result.stdout + result.stderr).not.toContain(SECRET)
  })
})
