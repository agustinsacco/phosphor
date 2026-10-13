import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { CONTROL_ROUTES, HOST_HEADERS } from '@phosphor/shared/control-api'
import { controlMachine } from './__fixtures__/machine'
import { runCli } from '../cli'
import { hostLogDirectory } from '../machine/log'

it('logs login, status, run and logout to the owner file with per-command traces and no secrets', async () => {
  const machine = await controlMachine()
  try {
    const secret = randomBytes(32).toString('hex')
    const env = { XDG_STATE_HOME: join(machine.root, 'state'), CONTROL_EDGE_SECRET: secret }
    const original = machine.context.fetch
    if (!original) throw new Error('missing fixture fetch')
    const headers: Headers[] = []
    const bodies: string[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      headers.push(new Headers(init?.headers))
      bodies.push(typeof init?.body === 'string' ? init.body : '')
      const response =
        new URL(String(url)).pathname === CONTROL_ROUTES.hostHeartbeat
          ? Response.json({ accepted: true, nextInSec: 30 })
          : await original(url, init)
      response.headers.set('x-request-id', '1'.repeat(32))
      return response
    }
    const context = {
      env,
      home: machine.root,
      platform: machine.context.platform,
      uid: process.getuid?.(),
      hostname: 'bee1',
      nodeVersion: process.versions.node,
      defaultResourceRoot: '/unused',
      heartbeat: {
        readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }) as const,
        random: () => 0,
        seq: { read: async () => 0, write: async () => {} },
      },
      control: { ...machine.context, fetch: fetchImpl },
    }
    const io = { stdout: () => {}, stderr: () => {} }
    const traceGroups: string[][] = []
    for (const command of ['login', 'status', 'run', 'logout']) {
      const start = headers.length
      const runAbort = new AbortController()
      const control =
        command === 'run'
          ? {
              ...context.control,
              signal: runAbort.signal,
              wait: async () => {
                runAbort.abort()
              },
            }
          : context.control
      expect(
        await runCli([command, '--config', machine.configPath], io, { ...context, control }),
      ).toBe(0)
      const traces = headers.slice(start).map((header) => header.get('x-phosphor-trace') ?? '')
      expect(traces.length).toBeGreaterThan(0)
      expect(new Set(traces).size).toBe(1)
      traceGroups.push(traces)
    }
    expect(new Set(traceGroups.map((group) => group[0])).size).toBe(4)
    for (const header of headers) {
      expect(header.get('x-phosphor-client')).toBe('host/0.0.0-dev.source')
      expect(header.get('x-phosphor-trace')).toMatch(/^[0-9a-f]{16}$/)
    }
    const text = await readFile(join(hostLogDirectory(env, machine.root), 'phosphor.log'), 'utf8')
    for (const command of ['login', 'status', 'run', 'logout']) {
      expect(text).toContain(`"command":"${command}"`)
    }
    expect(text).toContain('enrollment.created')
    expect(text).toContain('enrollment.poll')
    expect(text).toContain('enrollment.approved')
    expect(text).toContain('identity.saved')
    const lines = text.split('\n')
    const approved = lines.findIndex((line) => line.includes('[host] enrollment.approved'))
    const saved = lines.findIndex((line) => line.includes('[host] identity.saved'))
    const self = lines.findIndex(
      (line) =>
        line.includes('[control] call') &&
        line.includes('"route":"' + CONTROL_ROUTES.hostSelf + '"'),
    )
    expect(approved).toBeGreaterThan(-1)
    expect(saved).toBeGreaterThan(approved)
    expect(self).toBeGreaterThan(saved)
    expect(text).toContain('"requestId":"' + '1'.repeat(32) + '"')
    expect(text).toMatch(/"route":"\/api\/v1\/hosts\/self\/heartbeat".*"seq":/)
    for (const line of text.trim().split('\n'))
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z \[/)
    for (const value of [secret, 'BCDFGHJK', 'BCDF-GHJK', 'PRIVATE KEY'])
      expect(text).not.toContain(value)
    for (const header of headers)
      for (const name of [HOST_HEADERS.key, HOST_HEADERS.signature, HOST_HEADERS.nonce]) {
        const value = header.get(name)
        if (value) expect(text).not.toContain(value)
      }
    for (const body of bodies) if (body) expect(text).not.toContain(body)
  } finally {
    await machine.cleanup()
  }
})

it('refuses a configured origin with userinfo without putting it in the log', async () => {
  const machine = await controlMachine()
  try {
    const { writeFile } = await import('node:fs/promises')
    const { runLogin } = await import('../commands/login')
    const { createHostLog } = await import('../machine/log')
    const credential = randomBytes(32).toString('hex')
    const config = {
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: ['/srv/a'],
      control: {
        url: `https://${credential}:${credential}@example.com/private?secret=${credential}`,
      },
    }
    await writeFile(machine.configPath, JSON.stringify(config), { mode: 0o600 })
    const log = createHostLog(join(machine.root, 'logs'), [])
    expect((await runLogin({ ...machine.context, log: log.write })).exitCode).toBe(78)
    const text = await readFile(join(machine.root, 'logs', 'phosphor.log'), 'utf8')
    expect(text).not.toContain(credential)
    expect(text).not.toContain('/private')
    expect(machine.calls).toHaveLength(0)
  } finally {
    await machine.cleanup()
  }
})
