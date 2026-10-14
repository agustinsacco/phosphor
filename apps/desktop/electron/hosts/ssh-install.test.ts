import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { validSshRepository, validSshTarget, type SshInstallEvent } from '@shared/ssh-install'
import { createSshInstaller, parseSshEnrollment, sshArgs } from './ssh-install'

let dir: string
let installer: ReturnType<typeof createSshInstaller>
let events: SshInstallEvent[]
let terminal: Promise<void>
let enrollmentReceived: Promise<void>
let resolveEnrollment: () => void
let resolveTerminal: () => void
function send(event: SshInstallEvent) {
  events.push(event)
  if (event.kind === 'enrollment') resolveEnrollment()
  if (['done', 'failed', 'cancelled'].includes(event.kind)) resolveTerminal()
}
const log = vi.fn()
const verifyEnrollment = vi.fn(async () => true)
const fingerprint = 'abcd-1234-5678-90ef'
const output = `To add this machine:\n  2. Machines > Add a machine, and enter:  BCDF-GHJK\nKey fingerprint: ${fingerprint}. Phosphor shows the same one.\nWaiting for approval.\n`
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phosphor-ssh-test-'))
  await writeFile(
    join(dir, 'ssh'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const command = args.at(-1)
fs.appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n')
let input = ''
process.stdin.on('data', (data) => input += data)
process.stdin.on('end', () => {
 fs.appendFileSync(process.env.INPUT, JSON.stringify(input) + '\\n')
 if (process.env.HOLD === 'yes') {
 fs.writeFileSync(process.env.PID, String(process.pid))
 if (process.env.CHILD === 'yes') {
   const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'})
   fs.writeFileSync(process.env.CHILD_PID, String(child.pid))
 }
 setInterval(() => {}, 1000); return
 }
 if (command.includes('login')) {
   if (process.env.LOGIN_STDERR) process.stderr.write(process.env.LOGIN_STDERR)
   setTimeout(() => process.stdout.write(process.env.LOGIN_OUTPUT), 5)
   if (process.env.WAIT_LOGIN === 'yes') {
     setInterval(() => { if (fs.existsSync(process.env.APPROVAL)) process.exit(0) }, 10)
     return
   }
 }
 if (process.env.FAIL_COMMAND && command.includes(process.env.FAIL_COMMAND)) {
   process.stderr.write(process.env.FAIL_OUTPUT ?? ('remote-private-output\\n' + Array.from({length: 30}, (_, i) => 'line' + i).join('\\n')))
   process.exitCode = Number(process.env.FAIL_CODE)
   return
 }
 setTimeout(() => process.exit(0), 20)
})
`,
    { mode: 0o700 },
  )
  events = []
  enrollmentReceived = new Promise((resolve) => {
    resolveEnrollment = resolve
  })
  terminal = new Promise((resolve) => {
    resolveTerminal = resolve
  })
  log.mockClear()
  verifyEnrollment.mockReset().mockResolvedValue(true)
})
afterEach(async () => {
  vi.useRealTimers()
  installer?.stop()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const parentPid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'))
  if (parentPid > 0) {
    try {
      process.kill(parentPid, 'SIGKILL')
    } catch {
      /* Already reaped. */
    }
  }
  const childPid = Number(await readFile(join(dir, 'child-pid'), 'utf8').catch(() => '0'))
  if (childPid > 0) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      /* Already reaped. */
    }
  }
  await rm(dir, { recursive: true, force: true })
})
function make(env: Record<string, string> = {}, timeoutMs?: number) {
  installer = createSshInstaller({
    installer: async () => 'signed installer bytes',
    verifyEnrollment,
    log,
    timeoutMs,
    env: {
      PATH: dir,
      RECORD: join(dir, 'argv'),
      INPUT: join(dir, 'input'),
      PID: join(dir, 'pid'),
      CHILD_PID: join(dir, 'child-pid'),
      APPROVAL: join(dir, 'approval'),
      LOGIN_OUTPUT: output,
      ...env,
    },
  })
  return installer
}
async function complete() {
  await terminal
  await delay(0)
}

async function recorded(): Promise<string[][]> {
  return (await readFile(join(dir, 'argv'), 'utf8'))
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line))
}
it('uses exact hardened argv, installer stdin, ordered steps and home-relative setup', async () => {
  make().start('alice@machine.example', 'src/project', 1, send)
  await complete()
  const commands = [
    'sh -s --',
    '~/.local/bin/phosphor setup --repository "$HOME/src/project"',
    '~/.local/bin/phosphor login',
    '~/.local/bin/phosphor service install',
  ]
  expect(await recorded()).toEqual(
    commands.map((command) => [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '--',
      'alice@machine.example',
      command,
    ]),
  )
  expect(
    (await readFile(join(dir, 'input'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual(['signed installer bytes', '', '', ''])
  expect(events.filter((event) => event.kind === 'progress').map((event) => event.step)).toEqual([
    'install',
    'setup',
    'login',
    'service',
  ])
  expect(events).toContainEqual({
    kind: 'enrollment',
    step: 'login',
    code: 'BCDFGHJK',
    fingerprint,
  })
  expect(verifyEnrollment).toHaveBeenCalledWith('BCDFGHJK', fingerprint)
  expect(events.at(-1)).toEqual({ kind: 'done', step: 'service' })
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /alice|machine|BCDF|abcd|signed|remote-private/,
  )
})
it('uses plain noninteractive setup without a repository and fixed guidance for exit 64', async () => {
  make({ FAIL_COMMAND: 'setup', FAIL_CODE: '64' }).start('alias', '', 1, send)
  await complete()
  expect((await recorded()).at(-1)?.at(-1)).toBe('~/.local/bin/phosphor setup')
  expect(events.at(-1)).toMatchObject({
    kind: 'failed',
    message: 'Choose a repository on that machine and try again',
  })
  expect(await recorded()).toHaveLength(2)
})
it('refuses target injection and validates exact target boundaries before spawning', () => {
  make()
  for (const target of [
    '-o',
    '-oProxyCommand=bad',
    'user@host;id',
    'a b',
    'a\n',
    'x@y@z',
    '',
    'a'.repeat(65),
    'u@' + 'h'.repeat(254),
    '$(id)',
    'a\u0000',
  ]) {
    expect(validSshTarget(target), target).toBe(false)
    expect(() => installer.start(target, '', 1, () => undefined), target).toThrow(
      'Invalid SSH install input.',
    )
  }
  for (const target of ['alias', 'a'.repeat(64), 'u@' + 'h'.repeat(253), 'user@2001:db8::1'])
    expect(validSshTarget(target)).toBe(true)
  expect(sshArgs('alias', 'sh -s --').at(-2)).toBe('alias')
})
it('refuses unsafe repositories and accepts exact size and segment boundaries', () => {
  make()
  for (const repository of [
    '..',
    '.',
    'src/..',
    '-repo',
    'src/-repo',
    'a b',
    '"',
    '$HOME',
    '`id`',
    'a;b',
    '/repo',
    'a/'.repeat(16) + 'a',
    'a'.repeat(201),
    'src\n',
  ]) {
    expect(validSshRepository(repository), repository).toBe(false)
    expect(() => installer.start('alias', repository, 1, () => undefined)).toThrow(
      'Invalid SSH install input.',
    )
  }
  for (const repository of ['', 'a'.repeat(200), 'a/'.repeat(15) + 'a', 'src/project'])
    expect(validSshRepository(repository)).toBe(true)
})
it('parses only the fixed code and fingerprint shapes', () => {
  expect(parseSshEnrollment(output)).toEqual({ code: 'BCDFGHJK', fingerprint })
  for (const text of [
    output.replace('BCDF-GHJK', 'ABCD-EFGH'),
    output.replace(fingerprint, 'ABCD-1234-5678-90EF'),
    output.replace('Key fingerprint:', 'fingerprint:'),
    output.replace('and enter:  ', 'code: '),
    output.replace('Key fingerprint:', 'unrelated line\nKey fingerprint:'),
    output.replace('Key fingerprint:', '\nKey fingerprint:'),
  ])
    expect(parseSshEnrollment(text)).toBeNull()
})
it('refuses a mismatched control fingerprint before enrollment or service', async () => {
  verifyEnrollment.mockResolvedValue(false)
  make().start('alias', '', 1, send)
  await complete()
  expect(events.at(-1)).toMatchObject({
    kind: 'failed',
    step: 'login',
    message: 'The fingerprints could not be verified. Do not approve this machine.',
  })
  expect(events.some((event) => event.kind === 'enrollment')).toBe(false)
  expect(await recorded()).toHaveLength(3)
})
it('shows a fixed auth/host-key explanation and bounded output, without logging output', async () => {
  make({ FAIL_COMMAND: 'sh -s', FAIL_CODE: '255' }).start('alias', '', 1, send)
  await complete()
  expect(events.at(-1)).toMatchObject({
    kind: 'failed',
    message:
      'SSH could not connect. Check your keys and known_hosts by running ssh alias once in a terminal, then try again.',
    output: Array.from({ length: 20 }, (_, i) => 'line' + (i + 10)),
  })
  expect(await recorded()).toHaveLength(1)
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/alias|remote-private|line/)
})
it('keeps one job per target, bounds total jobs and checks cancellation ownership', async () => {
  const api = make({ HOLD: 'yes' })
  const job = api.start('alias', '', 1, send)
  expect(() => api.start('alias', '', 2, () => undefined)).toThrow('already running')
  for (let i = 0; i < 7; i++) api.start('alias' + i, '', 1, () => undefined)
  expect(() => api.start('overflow', '', 1, () => undefined)).toThrow('already running')
  await vi.waitFor(async () => expect(await readFile(join(dir, 'pid'), 'utf8')).toMatch(/^[0-9]+$/))
  api.cancel(job.jobId, 2)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(events.some((event) => event.kind === 'cancelled')).toBe(false)
  api.cancel(job.jobId, 1)
  await complete()
  expect(events.at(-1)?.kind).toBe('cancelled')
})
it('cancel kills the real fake ssh process group and releases its target', async () => {
  const api = make({ HOLD: 'yes', CHILD: 'yes' })
  const job = api.start('alias', '', 1, send)
  let pid = 0
  await vi.waitFor(async () => {
    pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
  })
  api.cancel(job.jobId, 1)
  await complete()
  expect(() => process.kill(pid, 0)).toThrow()
  const childPid = Number(await readFile(join(dir, 'child-pid'), 'utf8'))
  await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow())
  expect(() => api.start('alias', '', 1, () => undefined)).not.toThrow()
})
it('timeouts stop the job with fixed output and do not run later steps', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  make({ HOLD: 'yes' }, 100).start('alias', '', 1, send)
  await vi.advanceTimersByTimeAsync(0)
  for (let tries = 0; tries < 100; tries++) {
    if (await readFile(join(dir, 'pid'), 'utf8').catch(() => '')) break
    await delay(10)
  }
  expect(await readFile(join(dir, 'pid'), 'utf8')).toMatch(/^[0-9]+$/)
  await vi.advanceTimersByTimeAsync(100)
  vi.useRealTimers()
  await complete()
  expect(events.at(-1)).toMatchObject({
    kind: 'failed',
    message: 'This step timed out. Try again.',
  })
  expect(await recorded()).toHaveLength(1)
})
it('installer read failure never spawns SSH or exposes the exception', async () => {
  installer = createSshInstaller({
    installer: async () => {
      throw new Error('private path')
    },
    verifyEnrollment,
    log,
  })
  installer.start('alias', '', 1, send)
  await complete()
  expect(events.at(-1)).toMatchObject({ kind: 'failed', output: [] })
  expect(JSON.stringify(events) + JSON.stringify(log.mock.calls)).not.toContain('private path')
})
it('waits for the owning renderer subscription before starting and ignores duplicate readiness', async () => {
  const loader = vi.fn(async () => 'installer')
  installer = createSshInstaller({
    installer: loader,
    verifyEnrollment,
    log,
    waitForReady: true,
    env: { PATH: dir, RECORD: join(dir, 'argv'), INPUT: join(dir, 'input'), LOGIN_OUTPUT: output },
  })
  const job = installer.start('alias', '', 1, send)
  installer.ready(job.jobId, 2)
  await delay(30)
  expect(loader).not.toHaveBeenCalled()
  installer.ready(job.jobId, 1)
  installer.ready(job.jobId, 1)
  await complete()
  expect(loader).toHaveBeenCalledTimes(1)
  expect(await recorded()).toHaveLength(4)
})
it('handles missing system ssh with a fixed error and no exception detail', async () => {
  make({ PATH: join(dir, 'missing') }).start('alias', '', 1, send)
  await complete()
  expect(events.at(-1)).toEqual({
    kind: 'failed',
    step: 'install',
    message: 'Host install failed. Try again.',
    output: [],
  })
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/ENOENT|missing|alias/)
})
it('bounds a long unterminated remote line', async () => {
  make({
    LOGIN_OUTPUT: 'z'.repeat(100000),
    FAIL_OUTPUT: '',
    FAIL_COMMAND: 'login',
    FAIL_CODE: '1',
  }).start('alias', '', 1, send)
  await complete()
  const last = events.at(-1)
  expect(last?.kind).toBe('failed')
  if (last?.kind === 'failed') {
    expect(last.output).toEqual(['z'.repeat(32768)])
  }
})
it('keeps streamed login running for approval before installing the service', async () => {
  make({ WAIT_LOGIN: 'yes' }).start('alias', '', 1, send)
  await enrollmentReceived
  expect(events.at(-1)?.kind).toBe('enrollment')
  expect(await recorded()).toHaveLength(3)
  await writeFile(join(dir, 'approval'), '')
  await complete()
  expect((await recorded()).at(-1)?.at(-1)).toBe('~/.local/bin/phosphor service install')
})
it('rejects non-string input at the main boundary with fixed errors', () => {
  make()
  for (const value of [null, undefined, 42, {}, []]) {
    expect(validSshTarget(value)).toBe(false)
    expect(validSshRepository(value)).toBe(false)
    expect(() => installer.start(value, '', 1, () => undefined)).toThrow(
      'Invalid SSH install input.',
    )
    expect(() => installer.start('alias', value, 1, () => undefined)).toThrow(
      'Invalid SSH install input.',
    )
  }
})

it('verifies and delivers only genuine login stdout, ignoring an earlier stderr enrollment', async () => {
  const forged = output
    .replace('BCDF-GHJK', 'LMNP-QRST')
    .replace(fingerprint, '1111-2222-3333-4444')
  make({ LOGIN_STDERR: forged }).start('alias', '', 1, send)
  await complete()
  expect(verifyEnrollment.mock.calls).toEqual([['BCDFGHJK', fingerprint]])
  expect(events.filter((event) => event.kind === 'enrollment')).toEqual([
    { kind: 'enrollment', step: 'login', code: 'BCDFGHJK', fingerprint },
  ])
  expect(events.at(-1)).toEqual({ kind: 'done', step: 'service' })
})
