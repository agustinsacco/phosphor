import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from '../update/__fixtures__/release'
import { selectLocalBrainOwner } from '@phosphor/session-runtime/brain/local-owner'
import { acquireInstallLock } from '@phosphor/session-runtime/host-install/lock'
import { ownerLockPorts } from '@phosphor/session-runtime/owner-lock/owner-lock'
import { HOST_PATH_BLOCK } from '../machine/shell-path'
import { runUninstall } from './uninstall'
const logout = vi.hoisted(() => ({ run: vi.fn(async () => ({ exitCode: 0, message: 'ok' })) }))
vi.mock('./logout', () => ({ runLogout: logout.run }))
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  for (const path of ['.config/phosphor-host', '.local/state/phosphor-host']) {
    mkdirSync(join(f.home, path), { recursive: true, mode: 0o700 })
    writeFileSync(join(f.home, path, 'marker'), 'keep')
  }
  return f
}
afterEach(() => {
  logout.run.mockReset()
  logout.run.mockResolvedValue({ exitCode: 0, message: 'ok' })
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('removes program and own launcher, uninstalls service first and keeps config, identity, state and backup', async () => {
  const f = setup(),
    calls: string[][] = []
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  f.context.service = {
    runner: async (_p, args) => {
      calls.push([...args])
      expect(existsSync(f.lib)).toBe(true)
      return { code: args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' }
    },
  }
  writeFileSync(join(f.home, '.zshrc'), `# user config\n${HOST_PATH_BLOCK}# more config\n`)
  const backup = join(f.home, '.local/bin/phosphor.before-release')
  writeFileSync(backup, 'original')
  expect(await runUninstall(f.context)).toBe(0)
  expect(existsSync(f.lib)).toBe(false)
  expect(readFileSync(join(f.home, '.zshrc'), 'utf8')).toBe('# user config\n# more config\n')
  expect(existsSync(join(f.home, '.local/bin/phosphor'))).toBe(false)
  expect(calls.some((args) => args.includes('disable'))).toBe(true)
  expect(existsSync(unit)).toBe(false)
  for (const path of ['.config/phosphor-host', '.local/state/phosphor-host'])
    expect(readFileSync(join(f.home, path, 'marker'), 'utf8')).toBe('keep')
  expect(readFileSync(backup, 'utf8')).toBe('original')
  expect(f.messages.join('\n')).toContain('Kept config and identity:')
  expect(logout.run).not.toHaveBeenCalled()
})
it.each(['file', 'link'])('leaves a foreign launcher %s alone', async (kind) => {
  const f = setup(),
    launcher = join(f.home, '.local/bin/phosphor')
  rmSync(launcher)
  if (kind === 'file') writeFileSync(launcher, 'foreign')
  else symlinkSync('foreign', launcher)
  expect(await runUninstall(f.context)).toBe(0)
  expect(kind === 'file' ? readFileSync(launcher, 'utf8') : readlinkSync(launcher)).toBe('foreign')
})
it('source installs remove no program or launcher', async () => {
  const f = setup()
  f.context.update = { node: process.execPath }
  expect(await runUninstall(f.context)).toBe(0)
  expect(existsSync(f.lib)).toBe(true)
  expect(readlinkSync(join(f.home, '.local/bin/phosphor'))).toBe(
    join(f.lib, 'current/bin/phosphor'),
  )
  expect(f.messages.join('\n')).toContain('Source install:')
})
it('purges only after successful logout, and failed logout keeps everything', async () => {
  const f = setup()
  rmSync(join(f.home, '.local/state/phosphor-host/marker'))
  writeFileSync(join(f.home, '.local/state/phosphor-host/state.sqlite'), 'fixture')
  logout.run.mockResolvedValueOnce({ exitCode: 75, message: 'fail' })
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(join(f.home, '.config/phosphor-host/marker'))).toBe(true)
  expect(existsSync(join(f.home, '.local/state/phosphor-host/state.sqlite'))).toBe(true)
  expect(await runUninstall(f.context, true, true)).toBe(0)
  expect(existsSync(f.lib)).toBe(false)
  expect(existsSync(join(f.home, '.config/phosphor-host'))).toBe(false)
  expect(existsSync(join(f.home, '.local/state/phosphor-host'))).toBe(false)
})
it('purges migrated state and config but never follows the migrated Claude account root', async () => {
  const f = setup()
  const state = join(f.home, '.local/state/phosphor-host')
  const config = join(f.home, '.config/phosphor-host')
  const external = join(f.home, 'desktop-account-root')
  mkdirSync(external)
  writeFileSync(join(external, 'keep'), 'keep')
  rmSync(join(state, 'marker'))
  writeFileSync(join(config, 'folders.json'), '{}')
  writeFileSync(join(state, 'claude-accounts.json'), JSON.stringify({ version: 1, root: external }))
  for (const file of ['agent-policy.json', 'web-push.json', 'state.sqlite'])
    writeFileSync(join(state, file), 'fixture')
  for (const dir of ['claude-accounts', 'owner-migration', 'sandboxes', 'routines', 'artifacts']) {
    mkdirSync(join(state, dir))
    writeFileSync(join(state, dir, 'fixture'), 'fixture')
  }
  expect(await runUninstall(f.context, true, true)).toBe(0)
  expect(existsSync(state)).toBe(false)
  expect(existsSync(config)).toBe(false)
  expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('keep')
})
it('requires both purge flags and a default config path, and refuses a held install lock', async () => {
  const f = setup()
  expect(await runUninstall(f.context, true)).toBe(64)
  expect(await runUninstall(f.context, false, true)).toBe(64)
  expect(
    await runUninstall({ ...f.context, configPath: join(f.home, 'other.json') }, true, true),
  ).toBe(64)
  const release = acquireInstallLock(f.lib)
  try {
    expect(await runUninstall(f.context)).toBe(75)
  } finally {
    release()
  }
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(f.lib)).toBe(true)
})
it('refuses symlinked data or launcher parents and wrong ownership before deletion', async () => {
  const f = setup(),
    state = join(f.home, '.local/state/phosphor-host')
  expect(await runUninstall({ ...f.context, uid: (f.context.uid ?? 0) + 1 }, true, true)).toBe(75)
  rmSync(state, { recursive: true })
  symlinkSync(f.old, state)
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(f.lib)).toBe(true)
  const bin = join(f.home, '.local/bin')
  rmSync(bin, { recursive: true })
  symlinkSync(f.old, bin)
  expect(await runUninstall(f.context)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
})
it.each(['linux', 'darwin'] as const)(
  'stops a loaded %s service even without its file',
  async (platform) => {
    const f = setup(),
      calls: string[][] = []
    f.context.platform = platform
    let active = true
    f.context.service = {
      runner: async (_p, args) => {
        calls.push([...args])
        expect(existsSync(f.lib)).toBe(true)
        if (args.includes('stop') || args.includes('bootout')) active = false
        return {
          code:
            args.includes('is-active') || args.includes('print')
              ? active
                ? 0
                : 3
              : args.includes('disable')
                ? 1
                : 0,
          stdout: args.includes('show') ? 'not-found' : '',
          stderr: '',
        }
      },
    }
    expect(await runUninstall(f.context)).toBe(0)
    expect(calls.some((args) => args.includes(platform === 'linux' ? 'stop' : 'bootout'))).toBe(
      true,
    )
    expect(existsSync(f.lib)).toBe(false)
  },
)
it.each(['nonzero', 'throws'])(
  'uninstalls without a unit or systemd session (%s)',
  async (kind) => {
    const f = setup(),
      calls: string[][] = []
    f.context.service = {
      runner: async (_p, args) => {
        calls.push([...args])
        if (kind === 'throws') throw new Error('No systemd session')
        return { code: 1, stdout: '', stderr: '' }
      },
    }
    expect(await runUninstall(f.context)).toBe(0)
    expect(calls).toEqual([['--user', 'is-active', '--quiet', 'phosphor-host.service']])
    expect(existsSync(f.lib)).toBe(false)
  },
)
it('refuses to remove anything when a loaded Linux unit will not stop', async () => {
  const f = setup(),
    calls: string[][] = []
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  f.context.service = {
    runner: async (_p, args) => {
      calls.push([...args])
      return { code: args.includes('stop') ? 1 : 0, stdout: '', stderr: '' }
    },
  }
  expect(await runUninstall(f.context)).toBe(75)
  expect(calls.filter((args) => args.includes('is-active'))).toHaveLength(2)
  expect(calls.findIndex((args) => args.includes('stop'))).toBeLessThan(
    calls.findIndex((args) => args.includes('disable')),
  )
  expect(f.messages).toContain('The service could not be stopped.')
  expect(existsSync(unit)).toBe(true)
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(join(f.home, '.local/bin/phosphor'))).toBe(true)
  expect(existsSync(join(f.home, '.config/phosphor-host/marker'))).toBe(true)
  expect(existsSync(join(f.home, '.local/state/phosphor-host/marker'))).toBe(true)
})
it('leaves the program in place if service uninstall fails', async () => {
  const f = setup(),
    unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  f.context.service = { runner: async () => ({ code: 1, stdout: 'loaded', stderr: '' }) }
  expect(await runUninstall(f.context)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(unit)).toBe(true)
})

it('refuses purge before logout or service changes if state contains foreign files', async () => {
  const f = setup()
  expect(await runUninstall(f.context, true, true)).not.toBe(0)
  expect(logout.run).not.toHaveBeenCalled()
  expect(readFileSync(join(f.home, '.local/state/phosphor-host/marker'), 'utf8')).toBe('keep')
  expect(existsSync(f.lib)).toBe(true)
})

it.each(['public state', 'shared log folder'])('refuses purge of a %s', async (kind) => {
  const f = setup()
  const state = join(f.home, '.local/state/phosphor-host')
  rmSync(join(state, 'marker'))
  if (kind === 'public state') chmodSync(state, 0o750)
  else {
    mkdirSync(join(state, 'logs'), { mode: 0o700 })
    writeFileSync(join(state, 'logs/runner.log'), 'foreign')
  }
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(state)).toBe(true)
  if (kind === 'shared log folder')
    expect(readFileSync(join(state, 'logs/runner.log'), 'utf8')).toBe('foreign')
})

const moveId = '6f09da93-f1bd-4df4-a3c0-1a1ca828eda2'
function movedBrain() {
  const f = setup()
  const state = join(f.home, '.local/state/phosphor-host')
  const brain = join(state, 'brain')
  const handover = join(state, 'brain-handover')
  const move = join(handover, moveId)
  const original = join(f.home, 'desktop-userData/brain-handover', moveId, 'original')
  rmSync(join(state, 'marker'))
  for (const dir of [brain, handover, move, original])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  const marker = { version: 1, migrationId: moveId, sourceGeneration: 'Harbor' }
  const record = { ...marker, sourceSchema: 8, desktopVersion: '1.0.0', state: 'committed' }
  function file(path: string, bytes: string) {
    writeFileSync(path, bytes, { mode: 0o600 })
  }
  file(join(brain, 'brain.sqlite'), 'synthetic store')
  file(join(brain, 'handover.json'), JSON.stringify(marker))
  file(join(move, 'state.json'), JSON.stringify(record))
  file(join(original, 'brain.sqlite'), 'Desktop original')
  file(join(f.lib, '.brain-required'), '1\n')
  return { f, state, brain, handover, move, original, record, file }
}

it('purges known committed source Host move and Brain state, not the Desktop original', async () => {
  const { f, state, original } = movedBrain()
  rmSync(f.lib, { recursive: true })
  expect(selectLocalBrainOwner(state, 'host')).toBe(true)
  expect(await runUninstall(f.context, true, true)).toBe(0)
  expect(existsSync(state)).toBe(false)
  expect(readFileSync(join(original, 'brain.sqlite'), 'utf8')).toBe('Desktop original')
})

it('refuses to purge a different root on a pinned install', async () => {
  const { f, brain } = movedBrain()
  f.context.env.XDG_STATE_HOME = join(f.home, 'some-other-state')
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(join(brain, 'brain.sqlite'))).toBe(true)
  expect(readFileSync(join(f.lib, '.brain-required'), 'utf8')).toBe('1\n')
})

it.each([
  'live claim',
  'unfinished move',
  'unknown state',
  'nested link',
  'hard link',
  'Desktop original inside move',
])('refuses purge before logout for %s', async (reason) => {
  const { f, brain, handover, move, original, record, file } = movedBrain()
  rmSync(f.lib, { recursive: true })
  if (reason === 'live claim')
    file(join(handover, 'active.json'), JSON.stringify({ migrationId: moveId }))
  if (reason === 'unfinished move')
    file(join(move, 'state.json'), JSON.stringify({ ...record, state: 'published' }))
  if (reason === 'unknown state') file(join(brain, 'Ledger'), 'foreign')
  if (reason === 'nested link') {
    mkdirSync(join(brain, 'Brain'), { mode: 0o700 })
    symlinkSync(join(original, 'brain.sqlite'), join(brain, 'Brain/AGENTS.md'))
  }
  if (reason === 'hard link') {
    rmSync(join(brain, 'brain.sqlite'))
    linkSync(join(original, 'brain.sqlite'), join(brain, 'brain.sqlite'))
  }
  if (reason === 'Desktop original inside move') mkdirSync(join(move, 'original'), { mode: 0o700 })
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(brain)).toBe(true)
  expect(readFileSync(join(original, 'brain.sqlite'), 'utf8')).toBe('Desktop original')
})

it('purges privately named native Brain resources, a killed writer lock and an aborted move', async () => {
  const { f, state, brain, move, record, file } = movedBrain()
  rmSync(f.lib, { recursive: true })
  rmSync(join(brain, 'handover.json'))
  file(join(move, 'state.json'), JSON.stringify({ ...record, state: 'aborted' }))
  mkdirSync(join(brain, 'Brain'), { mode: 0o700 })
  file(join(brain, 'Brain/AGENTS.md'), 'Fixture rules')
  file(join(state, 'brain-writer.lock'), await writerRecord(2147483647))
  expect(await runUninstall(f.context, true, true)).toBe(0)
  expect(existsSync(state)).toBe(false)
})

/** A valid Brain writer record; 2^31-1 is a killed holder, this test process a live one. */
async function writerRecord(pid: number, token = 'b'.repeat(64)): Promise<string> {
  const processStart = await ownerLockPorts.processStart(pid)
  const record = { version: 1, pid, processStart, token, startedAt: '2026-11-01T00:00:00.000Z' }
  return JSON.stringify(record) + '\n'
}

it.each(['invalid record', 'live holder', 'foreign directory', 'interrupted reclamation'])(
  'refuses purge before logout and keeps the Brain writer lock for a %s',
  async (reason) => {
    const { f, state, brain, file } = movedBrain()
    rmSync(f.lib, { recursive: true })
    const lock = join(state, 'brain-writer.lock')
    const gate = `${lock}-recovery`
    if (reason === 'invalid record') file(lock, '{"version":1,"pid":2147483647}\n')
    if (reason === 'live holder') file(lock, await writerRecord(process.pid))
    if (reason === 'foreign directory') {
      mkdirSync(lock, { mode: 0o700 })
      file(join(lock, 'Ledger'), 'keep')
    }
    if (reason === 'interrupted reclamation') {
      file(lock, await writerRecord(2147483647))
      mkdirSync(gate, { mode: 0o700 })
    }
    expect(await runUninstall(f.context, true, true)).toBe(75)
    expect(logout.run).not.toHaveBeenCalled()
    expect(existsSync(join(brain, 'brain.sqlite'))).toBe(true)
    expect(existsSync(lock)).toBe(true)
    if (reason === 'foreign directory')
      expect(readFileSync(join(lock, 'Ledger'), 'utf8')).toBe('keep')
    if (reason === 'interrupted reclamation') {
      expect(existsSync(gate)).toBe(true)
      const message = f.messages.join('\n')
      expect(message).toContain('brain-writer.lock-recovery')
      expect(message).not.toContain(state)
    }
  },
)

it('keeps a writer lock replaced by a live holder after the purge check, and its Brain', async () => {
  const { f, state, brain } = movedBrain()
  rmSync(f.lib, { recursive: true })
  const lock = join(state, 'brain-writer.lock')
  writeFileSync(lock, await writerRecord(2147483647), { mode: 0o600 })
  const live = await writerRecord(process.pid, 'c'.repeat(64))
  logout.run.mockImplementationOnce(async () => {
    rmSync(lock)
    writeFileSync(lock, live, { mode: 0o600 })
    return { exitCode: 0, message: 'ok' }
  })
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(readFileSync(lock, 'utf8')).toBe(live)
  expect(existsSync(join(brain, 'brain.sqlite'))).toBe(true)
})

it.each([false, true])(
  'refuses protected uninstall before taking any destructive action (purge=%s)',
  async (purge) => {
    const { f, brain } = movedBrain()
    const runner = vi.fn(f.context.service!.runner)
    f.context.service = { runner }
    expect(await runUninstall(f.context, purge, purge)).toBe(75)
    expect(logout.run).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(brain, 'brain.sqlite'))).toBe(true)
    expect(readFileSync(join(f.lib, '.brain-required'), 'utf8')).toBe('1\n')
    expect(existsSync(join(f.lib, 'current'))).toBe(true)
    expect(existsSync(join(f.home, '.local/bin/phosphor'))).toBe(true)
  },
)

it.each(['noncanonical', 'hard link', 'foreign sibling'])(
  'refuses purge of an unsafe owner selection: %s',
  async (reason) => {
    const { f, state, file } = movedBrain()
    rmSync(f.lib, { recursive: true })
    const owner = join(state, 'brain-owner.json')
    expect(selectLocalBrainOwner(state, 'host')).toBe(true)
    if (reason === 'noncanonical') file(owner, '{ "version": 1, "owner": "host" }\n')
    if (reason === 'hard link') linkSync(owner, join(f.home, 'Ledger'))
    if (reason === 'foreign sibling') file(join(state, 'brain-owner.json.Ledger'), 'keep')
    expect(await runUninstall(f.context, true, true)).toBe(75)
    expect(logout.run).not.toHaveBeenCalled()
    expect(existsSync(owner)).toBe(true)
    if (reason === 'foreign sibling')
      expect(readFileSync(join(state, 'brain-owner.json.Ledger'), 'utf8')).toBe('keep')
  },
)
