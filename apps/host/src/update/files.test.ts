import type * as Fs from 'node:fs'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicRecord } from './files'
import { fixture } from './__fixtures__/release'
const hooks = vi.hoisted(() => ({ writeFailure: false, syncFailure: false, syncs: 0 }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (hooks.writeFailure) throw new Error('fake disk failure')
      return fs.writeFileSync(...args)
    },
    fsyncSync: (fd: number) => {
      hooks.syncs++
      if (hooks.syncFailure) throw new Error('fake sync failure')
      fs.fsyncSync(fd)
    },
  }
})
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  hooks.writeFailure = false
  hooks.syncFailure = false
  hooks.syncs = 0
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('syncs an atomic record at its required mode before replacing the old file', () => {
  const f = fixture()
  fixtures.push(f)
  const path = join(f.home, 'record')
  writeFileSync(path, 'old')
  const mask = process.umask(0o077)
  try {
    atomicRecord(path, { current: '1.2.3', previous: '1.0.0' }, 0o644)
  } finally {
    process.umask(mask)
  }
  expect(hooks.syncs).toBe(1)
  expect(statSync(path).mode & 0o777).toBe(0o644)
  expect(JSON.parse(readFileSync(path, 'utf8')).current).toBe('1.2.3')
})
it.each(['write', 'sync'])(
  'a failed %s keeps the old record and removes the temporary file',
  (failure) => {
    const f = fixture()
    fixtures.push(f)
    const path = join(f.home, 'record')
    writeFileSync(path, 'old')
    hooks.writeFailure = failure === 'write'
    hooks.syncFailure = failure === 'sync'
    expect(() => atomicRecord(path, { current: '1.2.3' }, 0o600)).toThrow('fake')
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(f.home).some((name) => name.startsWith('.update-'))).toBe(false)
  },
)
