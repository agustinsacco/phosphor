// Signed Host bundle suite: the built Host's doctor, routines and guided terminal setup.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIdentityStore, identityDirectory } from '../../apps/host/src/control/identity'
import { controlMachine } from '../../apps/host/src/control/__fixtures__/machine'
import { freshKey } from '../../apps/host/src/control/signer'
import { fakeMachine } from '../../apps/host/src/__fixtures__/machine'
import {
  type BundleFixture,
  disposeBundleFixture,
  install,
  installPrepared,
  setupBundleFixture,
} from './__fixtures__/bundle-fixture'
/** The resumable terminal flow is already provisioned, so it must not prompt or install code. */
function installHostDefaults(machine: ReturnType<typeof fakeMachine>) {
  machine.installClaude()
  const names = ['@saccolabs/pi-claude-cli', 'pi-subagents', 'pi-web-access']
  for (const name of names.slice(1)) {
    const directory = join(machine.agentDir, 'npm/node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  writeFileSync(
    join(machine.agentDir, 'settings.json'),
    JSON.stringify({ packages: names.map((name) => `npm:${name}`) }),
  )
}
let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
}, 60000)
afterAll(() => disposeBundleFixture(fixture))

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('runs doctor and initializes routines from the built Host without SQLite warnings or folders', async () => {
    const machine = fakeMachine()
    const server = createServer((_request, response) => {
      response.writeHead(410, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'gone', message: 'removed' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      machine.writeConfig({
        ...machine.config,
        repositories: [],
        control: { url: origin },
      })
      await createIdentityStore(identityDirectory(machine.configPath), process.getuid?.()).save(
        {
          version: 1,
          hostId: '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00',
          label: 'test',
          ownerLogin: null,
          controlUrl: origin,
          savedAt: new Date().toISOString(),
        },
        freshKey(),
      )
      const { home, result } = install(fixture)
      expect(result.status, result.stderr).toBe(0)
      for (const command of ['doctor', 'run']) {
        const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const process = spawn(
              join(home, '.local/bin/phosphor'),
              [command, '--config', machine.configPath],
              {
                signal: AbortSignal.timeout(15000),
                env: {
                  ...machine.hostEnv,
                  NODE_OPTIONS: '',
                  DYLD_INSERT_LIBRARIES: '',
                  LD_PRELOAD: '',
                  PI_CODING_AGENT_DIR: machine.agentDir,
                  XDG_STATE_HOME: join(machine.dir, 'state'),
                },
              },
            )
            let stdout = '',
              stderr = ''
            process.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            process.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            process.on('error', reject)
            process.on('close', (status) => resolve({ status, stdout, stderr }))
          },
        )
        expect(child.stderr).not.toContain('ExperimentalWarning')
        expect(child.status, child.stdout + child.stderr).toBe(command === 'doctor' ? 0 : 77)
      }
      expect(existsSync(join(machine.dir, 'state/phosphor-host/routines/state.sqlite'))).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      machine.cleanup()
    }
  })
  it('runs the terminal install command and guided setup against local control, then resumes safely', async () => {
    const control = await controlMachine()
    const machine = fakeMachine()
    installHostDefaults(machine)
    control.setCreation({ expiresAt: new Date(Date.now() + 600000).toISOString() })
    const fetch = control.context.fetch
    if (!fetch) throw new Error('fixture fetch')
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const answer = await fetch(`http://localhost${request.url}`, {
          method: request.method,
          headers,
          body: Buffer.concat(chunks).toString() || undefined,
        })
        response.writeHead(answer.status, { 'Content-Type': 'application/json' })
        response.end(await answer.text())
      })().catch(() => {
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture address')
      let release = ''
      const prepared = installPrepared(fixture, (_home, source) => {
        release = source
        return {}
      })
      expect(prepared.result.status, prepared.result.stderr).toBe(0)
      const home = mkdtempSync(join(fixture.dir, 'terminal-home-'))
      const config = join(home, '.config/phosphor-host')
      mkdirSync(config, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(config, 'config.json'),
        JSON.stringify({
          ...machine.config,
          repositories: [],
          environment: { path: [machine.bin] },
          control: { url: `http://127.0.0.1:${address.port}` },
        }),
        { mode: 0o600 },
      )
      machine.script(
        'launchctl',
        'case "$1" in print) [ -f "$HOME/service-ready" ] || exit 113; echo "state = running" ;; bootstrap) touch "$HOME/service-ready" ;; esac',
      )
      machine.script(
        'systemctl',
        'case "$2" in is-active) [ -f "$HOME/service-ready" ] || exit 3 ;; restart) touch "$HOME/service-ready" ;; esac',
      )
      machine.script('loginctl', 'exit 0')
      machine.script(
        'tailscale',
        `case "$1 $2" in
        "debug prefs") echo '{"OperatorUser":"${userInfo().username}"}' ;;
        "status --json") echo '{"BackendState":"Running","CertDomains":["bee.tail.ts.net"],"Self":{"DNSName":"bee.tail.ts.net."}}' ;;
        "serve status") if [ -f "$HOME/route-ready" ]; then echo '{"TCP":{"47615":{"HTTPS":true}},"Web":{"bee.tail.ts.net:47615":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47615"}}}}}'; else echo '{}'; fi ;;
        "serve --bg") touch "$HOME/route-ready" ;;
        *) exit 1 ;;
      esac`,
      )
      // The helper prepares versioned manifests; publish its same signed bytes under the latest alias.
      cpSync(
        join(release, 'phosphor-host-1.2.3.manifest.json'),
        join(release, 'phosphor-host.manifest.json'),
      )
      cpSync(
        join(release, 'phosphor-host-1.2.3.manifest.json.sig'),
        join(release, 'phosphor-host.manifest.json.sig'),
      )
      const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const flow =
            // util-linux `script -c` runs the flow with $SHELL, so keep that /bin/sh and set
            // the user's shell (which picks the rc file) inside the flow instead.
            'export SHELL=/bin/sh && sh "$INSTALLER" && export PATH="$HOME/.local/bin:$PATH" && command -v phosphor && phosphor setup && phosphor setup'
          const command = spawn(
            'script',
            process.platform === 'darwin'
              ? ['-q', '/dev/null', 'sh', '-c', flow]
              : ['-q', '-e', '-c', flow, '/dev/null'],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              signal: AbortSignal.timeout(20000),
              env: {
                HOME: home,
                SHELL: '/bin/sh',
                USER: 'tester',
                PATH: `${machine.bin}:/usr/bin:/bin`,
                INSTALLER: fixture.script,
                PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
                PI_CODING_AGENT_DIR: machine.agentDir,
              },
            },
          )
          let stdout = '',
            stderr = ''
          command.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          command.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          command.on('error', reject)
          command.on('close', (status) => resolve({ status, stdout, stderr }))
        },
      )
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(child.stdout).toContain(join(home, '.local/bin/phosphor'))
      expect(child.stdout.match(/Ready\. Open .* in Phosphor\./g)).toHaveLength(2)
      expect(child.stdout).not.toMatch(/Config ready|extra PATH|already set up|next:/)
      expect(existsSync(join(home, 'service-ready'))).toBe(true)
      expect(existsSync(join(home, 'route-ready'))).toBe(true)
      expect(control.calls.filter((call) => call.path.endsWith('/enrollments'))).toHaveLength(1)
      expect(child.stderr).not.toContain('ExperimentalWarning')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      machine.cleanup()
      await control.cleanup()
    }
  })
})
