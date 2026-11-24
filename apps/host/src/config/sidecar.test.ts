import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSidecar, writeSidecar } from './sidecar'

const uid = process.getuid?.()
let dir: string
beforeEach(() => {
  dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'host-sidecar-'))), 'config')
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
})
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

const parse = (raw: Record<string, unknown>) =>
  raw.version === 1 && typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : null
const write = (text: string, mode = 0o600) => {
  writeFileSync(join(dir, 'headroom.json'), text, { mode })
  chmodSync(join(dir, 'headroom.json'), mode)
}

describe('sidecar files', () => {
  it('reads a missing, valid or refused sidecar', () => {
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toEqual({ state: 'missing' })
    write('{"version":1,"enabled":true}')
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toEqual({
      state: 'ok',
      value: { enabled: true },
    })
    write('{"version":2,"enabled":true}')
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({ reason: 'refused' })
    write('{"enabled":true}')
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({
      reason: 'no version',
    })
    write('{')
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({ reason: 'not JSON' })
    write(`{"version":1,"enabled":true,"pad":"${'x'.repeat(200)}"}`)
    expect(readSidecar(dir, 'headroom.json', parse, { uid, maxBytes: 100 })).toMatchObject({
      reason: 'unreadable',
    })
    expect(readSidecar(dir, 'headroom.json', parse, { uid: undefined })).toMatchObject({
      state: 'invalid',
    })
  })

  it('refuses a sidecar others can read or write, a linked one, or one in an open folder', () => {
    write('{"version":1,"enabled":true}', 0o644)
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({
      reason: 'not owner-only',
    })
    rmSync(join(dir, 'headroom.json'))
    writeFileSync(join(dir, 'real.json'), '{"version":1,"enabled":true}', { mode: 0o600 })
    symlinkSync(join(dir, 'real.json'), join(dir, 'headroom.json'))
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({
      reason: 'not a plain file',
    })
    rmSync(join(dir, 'headroom.json'))
    write('{"version":1,"enabled":true}')
    chmodSync(dir, 0o755)
    expect(readSidecar(dir, 'headroom.json', parse, { uid })).toMatchObject({
      reason: 'not owner-only',
    })
    expect(() =>
      writeSidecar(dir, 'headroom.json', { version: 1 }, { uid, known: ['version'] }),
    ).toThrow('not owner-only')
  })

  it('writes atomically, owner-only, keeping keys a newer Host wrote', () => {
    write('{"version":1,"enabled":true,"future":{"kept":1},"stale":true}')
    writeSidecar(
      dir,
      'headroom.json',
      { version: 1, enabled: false },
      { uid, known: ['version', 'enabled', 'stale'] },
    )
    expect(JSON.parse(readFileSync(join(dir, 'headroom.json'), 'utf8'))).toEqual({
      future: { kept: 1 },
      version: 1,
      enabled: false,
    })
    expect(statSync(join(dir, 'headroom.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['headroom.json'])
    expect(() =>
      writeSidecar(
        dir,
        'headroom.json',
        { version: 1, pad: 'x'.repeat(200) },
        { uid, known: [], maxBytes: 100 },
      ),
    ).toThrow('too large')
  })
})
