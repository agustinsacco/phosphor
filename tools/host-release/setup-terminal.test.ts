// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- node-pty ships an ambient-module .d.ts (no exports), so a relative type import is TS2306; this keeps its types local to this test
/// <reference path="../../apps/desktop/node_modules/node-pty/typings/node-pty.d.ts" />
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type * as NodePty from 'node-pty'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { spawn } = require('node-pty') as typeof NodePty

const dir = mkdtempSync(join(tmpdir(), 'host-setup-terminal-'))
const bundle = join(dir, 'prompt.mjs')
beforeAll(() => {
  const entry = join(dir, 'prompt.ts')
  writeFileSync(
    entry,
    `
    import { setupTerminal, SetupCancelled } from ${JSON.stringify(resolve('apps/host/src/commands/setup-terminal.ts'))}
    const terminal = setupTerminal(process.env)
    try {
      const yes = await terminal.confirm('Run the command?', 'phosphor setup')
      console.log('ANSWER=' + yes)
      if (yes) await terminal.run(process.execPath, ['-e', 'console.log("CHILD_TTY=" + process.stdin.isTTY + ":" + process.stdout.isTTY); console.log(process.argv[1])', 'literal; not a shell'])
    } catch (error) { console.log(error instanceof SetupCancelled ? 'CANCELLED' : 'ERROR') }
  `,
  )
  buildSync({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it.each(['\n', 'y\n', 'n\n', '\u0003'])('reads one terminal line safely: %j', async (answer) => {
  const child = spawn('/bin/sh', ['-c', 'exec "$NODE" "$BUNDLE"'], {
    name: 'xterm',
    cols: 100,
    rows: 30,
    env: { ...process.env, NODE: process.execPath, BUNDLE: bundle },
  })
  let output = ''
  let sent = false
  const timer = setTimeout(() => child.kill(), 5000)
  const code = await new Promise<number>((resolve) => {
    child.onData((chunk) => {
      output += chunk
      if (!sent && output.includes('[Y/n]')) {
        sent = true
        child.write(answer)
      }
    })
    child.onExit(({ exitCode }) => resolve(exitCode))
  })
  clearTimeout(timer)
  expect(code, output).toBe(0)
  if (answer === '\u0003') expect(output).toContain('CANCELLED')
  else if (answer === 'n\n') {
    expect(output).toContain('ANSWER=false')
    expect(output).not.toContain('CHILD_TTY=')
  } else {
    expect(output).toContain('ANSWER=true')
    expect(output).toContain('CHILD_TTY=true:true')
    expect(output).toContain('literal; not a shell')
  }
})

it('prints the command and does not run it without a terminal', () => {
  const result = spawnSync(process.execPath, [bundle], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Run: phosphor setup')
  expect(result.stdout).toContain('ANSWER=false')
  expect(result.stdout).not.toContain('CHILD_TTY=')
})
