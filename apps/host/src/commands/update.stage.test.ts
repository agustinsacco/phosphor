vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { fixture } from '../update/__fixtures__/release'
import { LANES_STOP_NOTICE, runUpdate } from './update'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

/** A running Linux service whose restart writes the heartbeat `healthy` decides. */
function service(options: { healthy?: boolean; local?: boolean } = {}) {
  const f = fixture()
  fixtures.push(f)
  f.release()
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  const state = join(f.home, '.local/state/phosphor-host')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  if (options.local) {
    mkdirSync(join(f.context.configPath, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(f.context.configPath, '../local-mode.json'),
      JSON.stringify({
        version: 1,
        enabledAt: '2026-11-23T00:00:00.000Z',
        shellEnvironment: false,
      }),
      { mode: 0o600 },
    )
  }
  let now = 10_000
  f.context.now = () => now
  f.context.wait = async () => {
    now += 1000
  }
  const calls: string[][] = []
  f.context.service = {
    runner: async (_program, args) => {
      calls.push([...args])
      if (args.includes('restart') && options.healthy !== false) {
        const record = { version: '1.2.3', pid: 1, startedAt: now, acceptedAt: now }
        atomicRecord(join(state, 'run.json'), record, 0o600)
        const local = {
          version: 1,
          pid: 1,
          hostVersion: '1.2.3',
          machineId: '00000000-0000-4000-8000-000000000001',
          socket: '/tmp/phosphor-d4-test.sock',
          startedAt: now,
          localReadyAt: now,
        }
        if (options.local) atomicRecord(join(state, 'local.json'), local, 0o600)
      }
      return { code: 0, stdout: '' }
    },
  }
  const probe = vi.fn(async () => ({ hostVersion: '1.2.3', protocolVersion: 1, features: [] }))
  const packages = vi.fn(async () => [])
  f.context.update = { ...f.context.update, probe }
  f.context.packages = packages
  const restarts = () => calls.filter((args) => args.includes('restart')).length
  const result = () => JSON.parse(readFileSync(join(state, 'update-result.json'), 'utf8'))
  return { f, probe, packages, restarts, result }
}

describe('update --stage', () => {
  it('publishes a probed release without selecting it, restarting or updating packages', async () => {
    const { f, probe, packages, restarts } = service()
    expect(await runUpdate(f.context, { stage: true })).toBe(0)
    expect(probe).toHaveBeenCalledWith(
      expect.stringContaining('.staging-'),
      expect.any(AbortSignal),
    )
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    expect(readdirSync(join(f.lib, 'versions')).sort()).toEqual(['1.0.0', '1.2.3'])
    expect(readdirSync(f.lib).filter((name) => name.startsWith('.staging-'))).toEqual([])
    expect(restarts()).toBe(0)
    expect(packages).not.toHaveBeenCalled()
    expect(f.messages).toEqual(['Staged Host 1.2.3; apply it with: phosphor update --apply 1.2.3'])
  })

  it('publishes nothing when the staged bundle reports another version', async () => {
    const { f, probe } = service()
    probe.mockResolvedValueOnce({ hostVersion: '9.9.9', protocolVersion: 1, features: [] })
    expect(await runUpdate(f.context, { stage: true })).toBe(75)
    expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
    expect(readdirSync(f.lib).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it.each([
    [{ stage: true, check: true }],
    [{ stage: true, version: '1.2.3' }],
    [{ stage: true, apply: '1.2.3' }],
    [{ apply: '1.2.3', rollback: true }],
    [{ apply: 'latest' }],
  ])('refuses %j as invalid options', async (options) => {
    const { f } = service()
    expect(await runUpdate(f.context, options)).toBe(64)
  })
})

describe('update --apply', () => {
  it('selects a staged release, restarts healthy, records it and leaves packages alone', async () => {
    const { f, packages, restarts, result } = service()
    expect(await runUpdate(f.context, { stage: true })).toBe(0)
    f.messages.length = 0
    expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(0)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
    expect(restarts()).toBe(1)
    expect(packages).not.toHaveBeenCalled()
    expect(f.messages).toEqual(['Phosphor Host service restarted.', 'Selected Host 1.2.3.'])
    expect(result()).toMatchObject({ version: 1, from: '1.0.0', to: '1.2.3', outcome: 'updated' })
  })

  it('rolls an unhealthy apply back and records it', async () => {
    const { f, restarts, result } = service({ healthy: false })
    expect(await runUpdate(f.context, { stage: true })).toBe(0)
    expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(75)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    expect(restarts()).toBe(2)
    expect(result()).toMatchObject({ from: '1.0.0', to: '1.2.3', outcome: 'rolled-back' })
  })

  it('refuses a release that was never staged, and does nothing for the current one', async () => {
    const { f, restarts } = service()
    expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(69)
    expect(f.messages).toEqual(['Host 1.2.3 is not staged; run: phosphor update --stage'])
    expect(await runUpdate(f.context, { apply: '1.0.0' })).toBe(0)
    expect(f.messages.at(-1)).toBe('Host 1.0.0 is already selected.')
    expect(restarts()).toBe(0)
  })
})

describe('a local daemon', () => {
  it('warns on a plain update that working lanes stop, and not on --apply', async () => {
    const plain = service({ local: true })
    expect(await runUpdate(plain.f.context)).toBe(0)
    expect(plain.f.messages[0]).toBe(LANES_STOP_NOTICE)
    const staged = service({ local: true })
    expect(await runUpdate(staged.f.context, { stage: true })).toBe(0)
    expect(await runUpdate(staged.f.context, { apply: '1.2.3' })).toBe(0)
    expect(staged.f.messages).not.toContain(LANES_STOP_NOTICE)
  })
})
