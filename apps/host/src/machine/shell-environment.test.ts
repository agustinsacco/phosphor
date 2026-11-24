import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createShellEnvironment } from './shell-environment'
import { createHostLog } from './log'
import { buildPiEnvironment } from './environment'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-env-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('uses the Host policy on the first timeout and keeps its last complete capture on a partial failure', async () => {
  const file = join(dir, 'profile')
  writeFileSync(file, '#!/bin/sh\nsleep 60\n', { mode: 0o700 })
  const policy = {
    hostEnv: { SHELL: file, HOME: dir, PATH: '/usr/bin:/bin' },
    platform: 'darwin' as const,
  }
  const shell = createShellEnvironment(policy, 500)
  const log = createHostLog(join(dir, 'logs'), [])
  shell.bindLog(log)
  expect(await shell.refresh()).toBe(false)
  expect(shell.current()).toEqual(buildPiEnvironment(policy))
  writeFileSync(
    file,
    '#!/bin/sh\nexport PATH="$HOME/new:$PATH" AWS_PROFILE=test-profile\neval "$2"\n',
  )
  expect(await shell.refresh()).toBe(true)
  const good = shell.current()
  writeFileSync(file, '#!/bin/sh\n[ "$2" != "env -0" ] || exit 1\neval "$2"\n')
  expect(await shell.refresh()).toBe(false)
  expect(shell.current()).toBe(good)
  writeFileSync(file, '#!/bin/sh\nsleep 60\n')
  const refresh = shell.refresh()
  expect(shell.refresh()).toBe(refresh)
  expect(await refresh).toBe(false)
  expect(shell.current()).toBe(good)
  expect(readFileSync(log.path()!, 'utf8').match(/environment\.shell_unavailable/g)).toHaveLength(3)
})

it('prepends stable absolute PATH entries but never imports shell hooks, layout or unasked authority', () => {
  const path = Array.from({ length: 300 }, (_, i) => `/path/${i}`)
  const { env } = buildPiEnvironment({
    hostEnv: { HOME: dir, AWS_REGION: 'daemon', SSH_AUTH_SOCK: 'launchd', CUSTOM: 'daemon' },
    platform: 'linux',
    path: ['/configured'],
    nodePath: '/node/bin/node',
    pass: [
      'SSH_AUTH_SOCK',
      'CUSTOM',
      'HOME',
      'XDG_STATE_HOME',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'PHOSPHOR_OP_CHANNEL',
      'PHOSPHOR_BRAIN_TOKEN',
    ],
    shell: {
      path: ['', 'relative', '/tmp/fnm_multishells/id/bin', '/first', '/first', ...path],
      values: {
        HOME: '/wrong',
        PI_CODING_AGENT_DIR: '/wrong',
        PI_CODING_AGENT_SESSION_DIR: '/wrong',
        XDG_STATE_HOME: '/wrong',
        NODE_OPTIONS: 'bad',
        LD_PRELOAD: 'bad',
        PHOSPHOR_OP_CHANNEL: 'bad',
        PHOSPHOR_BRAIN_TOKEN: 'bad',
        DISPLAY: ':1',
        AWS_REGION: 'shell',
        AWS_PROFILE: 'new',
        SSH_AUTH_SOCK: 'custom-agent',
        CUSTOM: 'shell',
      },
    },
  })
  expect(env).toEqual({
    HOME: dir,
    AWS_REGION: 'daemon',
    AWS_PROFILE: 'new',
    SSH_AUTH_SOCK: 'custom-agent',
    CUSTOM: 'daemon',
    PATH: expect.any(String),
  })
  expect(env.PATH!.split(':').slice(0, 258)).toEqual([
    '/first',
    ...path.slice(0, 255),
    '/node/bin',
    '/configured',
  ])
})
