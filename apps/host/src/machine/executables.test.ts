import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { buildPiEnvironment } from './environment'
import {
  checkGit,
  checkHostNode,
  isNodeScript,
  resolvePi,
  satisfiesEngines,
  which,
} from './executables'

let machine: FakeMachine
afterEach(() => machine?.cleanup())

const piEnv = (m: FakeMachine, extra: Record<string, string> = {}) =>
  buildPiEnvironment({ hostEnv: { ...m.hostEnv, ...extra }, platform: 'linux' })

describe('host node', () => {
  it('needs 22.19 or newer', () => {
    expect(checkHostNode('22.19.0').status).toBe('pass')
    expect(checkHostNode('24.14.1').status).toBe('pass')
    expect(checkHostNode('22.18.9')).toMatchObject({ status: 'fail', exit: 69 })
    // A prerelease of 22.19.0 comes before 22.19.0, as npm orders them.
    expect(checkHostNode('22.19.0-rc.1')).toMatchObject({ status: 'fail', exit: 69 })
  })
})

describe('finding programs', () => {
  it('takes the first executable file on the PATH, skipping folders and plain files', async () => {
    machine = fakeMachine()
    const [first, second, third] = ['a', 'b', 'c'].map((name) => join(machine.dir, name))
    mkdirSync(join(first!, 'tool'), { recursive: true })
    mkdirSync(second!)
    writeFileSync(join(second!, 'tool'), 'not executable')
    mkdirSync(third!)
    writeFileSync(join(third!, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(join(third!, 'tool'), 0o755)
    expect(await which('tool', [first, '', second, third].join(':'))).toBe(join(third!, 'tool'))
    expect(await which('tool', first!)).toBeNull()
  })

  it('recognizes a Node script by extension or shebang', async () => {
    machine = fakeMachine()
    const write = (name: string, content: string) => {
      writeFileSync(join(machine.dir, name), content)
      return join(machine.dir, name)
    }
    expect(await isNodeScript(machine.cli)).toBe(true)
    expect(await isNodeScript(write('a', '#!/usr/bin/env node\n'))).toBe(true)
    expect(await isNodeScript(write('b', '#!/usr/local/bin/node --flag\n'))).toBe(true)
    expect(await isNodeScript(write('c', '#!/bin/sh\nexec node cli.js\n'))).toBe(false)
    expect(await isNodeScript(write('d', '\x7fELF'))).toBe(false)
  })
})

describe("pi's engines.node", () => {
  it.each([
    ['22.19.0', '>=22.19.0', true],
    ['22.18.9', '>=22.19.0', false],
    ['22.19.0', '>= 22.19', true],
    ['21.9.9', '>=22', false],
    ['24.14.1', '^24.0.0', true],
    ['22.22.3', '^24.0.0', false],
    ['25.0.0', '^24', false],
    ['20.19.1', '^20.19.0 || >=22.12.0', true],
    ['21.7.3', '^20.19.0 || >=22.12.0', false],
    ['22.22.3', '^20.19.0 || >=22.12.0', true],
    ['22.19.0', '>=18 <23', true],
    ['23.0.0', '>=18 <23', false],
    ['22.4.9', '~22.4.1', true],
    ['22.5.0', '~22.4', false],
    ['22.20.0', '>22.19', true],
    ['22.19.9', '>22.19', false],
    ['22.19.9', '<=22.19', true],
    ['22.20.0', '<=22.19', false],
    ['22.30.1', '22', true],
    ['22.19.1', '22.19.0', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    // npm checks engines with prereleases included. A prerelease sorts below its release; a
    // partial lower bound admits it, except after ~; no upper bound npm works out admits the
    // next version's. Every row here is what npm 7.7.4's semver answers.
    ['22.19.0-rc.1', '>=22.19.0', false],
    ['24.0.0-rc.1', '>=22.19.0', true],
    ['24.0.0-rc.1', '>=24', true],
    ['24.0.0-rc.1', '^24', true],
    ['24.0.0-rc.1', '^24.0.0', false],
    ['24.0.0-rc.1', '~24', false],
    ['25.0.0-rc.1', '^24', false],
    ['25.0.0-rc.1', '<25.0.0', true],
    ['25.0.0-rc.1', '<25', false],
    ['25.0.0-rc.1', '<=24', false],
    ['25.0.0-rc.1', '>24', true],
    ['25.0.0-rc.1', '24', false],
    ['24.0.0-rc.1', '24', true],
    ['22.19.0-rc.1', '>=22.19', true],
    ['22.20.0-rc.1', '~22.19', false],
  ])('node %s against %j: %s', (version, range, expected) => {
    expect(satisfiesEngines(version, range)).toBe(expected)
  })

  it.each([
    '22.x',
    '18 - 22',
    '>=22.19.0-0',
    '*',
    '',
    'latest',
    // A matching alternative does not rescue a range with a part this cannot read.
    '22.x || >=22.19.0',
    // Nine digits a part at most: a longer number would lose its value in arithmetic.
    '>=1000000000000000000000.0.0',
    '^1234567890',
    // npm reads no number with a leading zero, and no operator standing alone.
    '>=022.19.0',
    '^022',
    '>=22.019',
    '> = 22',
  ])('cannot read %j', (range) => {
    expect(satisfiesEngines('22.22.3', range)).toBeNull()
  })

  it('satisfies nothing with a node version it cannot read', () => {
    for (const version of [
      // Nine digits a part at most.
      '1234567890.0.0',
      // npm's grammar: no leading zero, and a prerelease of numbers, or letters, digits and hyphens.
      '022.22.3',
      '22.022.3',
      '24.0.0-rc_1',
      '24.0.0-01',
      '24.0.0-rc..1',
      // npm reads no version longer than 256 characters.
      `24.0.0-${'a'.repeat(250)}`,
    ]) {
      expect(satisfiesEngines(version, '>=22'), version).toBe(false)
    }
    // Just inside those rules, as npm reads them too.
    expect(satisfiesEngines(`24.0.0-${'a'.repeat(249)}`, '>=22')).toBe(true)
    expect(satisfiesEngines('24.0.0--0', '>=22')).toBe(true)
    expect(satisfiesEngines('999999999.0.0', '>=22')).toBe(true)
    expect(satisfiesEngines('22.22.3', '>= v22')).toBe(true)
  })
})

describe('resolving pi', () => {
  it('starts a Node-script pi as the pinned node plus the cli', async () => {
    machine = fakeMachine()
    const { checks, launch } = await resolvePi(
      { node: process.execPath, executable: machine.pi },
      piEnv(machine),
    )
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['pi-node', 'pass'],
      ['pi', 'pass'],
    ])
    expect(launch).toEqual({
      binaryPath: process.execPath,
      prefixArgs: [machine.cli],
      version: '1.2.0',
    })
  })

  it('needs /pi/node for a Node script: a config problem', async () => {
    machine = fakeMachine()
    const { checks, launch } = await resolvePi({ executable: machine.pi }, piEnv(machine))
    expect(checks).toEqual([
      {
        id: 'pi',
        status: 'fail',
        summary: `${machine.cli} is a Node script: set /pi/node to the node that runs it`,
        exit: 78,
      },
    ])
    expect(launch).toBeNull()
  })

  it('runs a native pi directly', async () => {
    machine = fakeMachine()
    const pi = machine.script('native-pi', 'echo "pi 1.3.0"')
    expect(await resolvePi({ executable: pi }, piEnv(machine))).toEqual({
      checks: [{ id: 'pi', status: 'pass', summary: `${pi} 1.3.0` }],
      launch: { binaryPath: pi, prefixArgs: [], version: '1.3.0' },
    })
  })

  it.each([
    ['an old pi', { piVersion: '0.86.0' }, 'is pi 0.86.0; Phosphor needs 1.2.0 or newer'],
    [
      'a version its package disowns',
      { manifestVersion: '0.90.0' },
      'its package.json says 0.90.0',
    ],
  ])('refuses %s', async (_name, options, message) => {
    machine = fakeMachine(options)
    const { checks, launch } = await resolvePi(
      { node: process.execPath, executable: machine.pi },
      piEnv(machine),
    )
    expect(checks.at(-1)).toMatchObject({ id: 'pi', status: 'fail', exit: 69 })
    expect(checks.at(-1)?.summary).toContain(message)
    expect(launch).toBeNull()
  })

  it('refuses missing or unusable binaries', async () => {
    machine = fakeMachine()
    const env = piEnv(machine)
    const missing = join(machine.dir, 'missing')
    const plain = join(machine.dir, 'plain')
    writeFileSync(plain, 'not a program')
    for (const [pi, problem] of [
      [{ node: process.execPath, executable: missing }, `${missing} does not exist`],
      [{ node: missing, executable: machine.pi }, `${missing} does not exist`],
      [{ node: plain, executable: machine.pi }, `${plain} is not executable`],
      [{ executable: plain }, `${plain} is not executable`],
    ] as const) {
      const { checks } = await resolvePi(pi, env)
      expect(checks.at(-1)).toMatchObject({ status: 'fail', summary: problem })
    }
  })

  it("refuses a node older than pi's engines", async () => {
    machine = fakeMachine()
    const node = machine.script('old-node', 'echo v20.11.0')
    const { checks } = await resolvePi({ node, executable: machine.pi }, piEnv(machine))
    expect(checks.at(-1)?.summary).toBe(`${node} is node 20.11.0; pi needs node >=22.19.0`)
  })

  it.each([
    ['^24.0.0', 'is node 22.22.3; pi needs node ^24.0.0'],
    ['22.x', `pi's engines.node "22.x" is a range this Host cannot read`],
    [
      '>=1000000000000000000000.0.0',
      `pi's engines.node ">=1000000000000000000000.0.0" is a range this Host cannot read`,
    ],
  ])("holds pi's node to engines.node %s, never to a lower floor", async (engines, message) => {
    machine = fakeMachine({ engines })
    const node = machine.script('node-22', 'echo v22.22.3')
    const { checks, launch } = await resolvePi({ node, executable: machine.pi }, piEnv(machine))
    expect(checks).toEqual([
      { id: 'pi-node', status: 'fail', summary: expect.stringContaining(message), exit: 69 },
    ])
    expect(launch).toBeNull()
  })

  it.each([22, ['>=22'], null])(
    'refuses an engines.node of %j, which is not a range',
    async (engines) => {
      machine = fakeMachine({ engines })
      const node = machine.script('node-22', 'echo v22.22.3')
      const { checks, launch } = await resolvePi({ node, executable: machine.pi }, piEnv(machine))
      expect(checks).toEqual([
        {
          id: 'pi-node',
          status: 'fail',
          summary: "pi's engines.node is not a range: it is not a string",
          exit: 69,
        },
      ])
      expect(launch).toBeNull()
    },
  )

  it('gives up on a pi that hangs', async () => {
    machine = fakeMachine()
    const { checks } = await resolvePi(
      { node: process.execPath, executable: machine.pi },
      piEnv(machine, { PI_FAKE_MODE: 'hang' }),
      { timeoutMs: 1_500 },
    )
    expect(checks.at(-1)?.summary).toMatch(/--version failed: timed out$/)
  })
})

describe('git', () => {
  it("is found on pi's PATH, and only there", async () => {
    const found = await checkGit({ env: { PATH: '/usr/bin:/bin' }, secrets: [] })
    expect(found.check.status).toBe('pass')
    expect(found.git).toMatch(/\/git$/)
    machine = fakeMachine()
    expect(await checkGit({ env: { PATH: machine.dir }, secrets: [] })).toEqual({
      check: {
        id: 'git',
        status: 'fail',
        summary: `git is not on pi's PATH (${machine.dir})`,
        exit: 69,
      },
      git: null,
    })
  })
})
