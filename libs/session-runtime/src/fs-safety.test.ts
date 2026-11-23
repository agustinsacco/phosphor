import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { errnoCode, errnoIs, isInside, isOwnerPrivate } from './fs-safety'

const coded = (code: unknown) => Object.assign(new Error('failed'), { code })
const octal = (modes: number[]) =>
  modes.map((mode) => [mode.toString(8).padStart(4, '0'), mode] as const)

describe('errnoCode', () => {
  it.each<[string, unknown, string | undefined]>([
    ['an Error with a string code', coded('ENOENT'), 'ENOENT'],
    ['an Error without a code', new Error('failed'), undefined],
    ['an Error with a numeric code', coded(-2), undefined],
    ['an Error with an undefined code', coded(undefined), undefined],
    ['a plain record with a string code', { code: 'EEXIST' }, 'EEXIST'],
    ['a plain record with a numeric code', { code: -17 }, undefined],
    ['a plain record without a code', { errno: -2 }, undefined],
    ['a null-prototype record', Object.assign(Object.create(null), { code: 'ELOOP' }), 'ELOOP'],
    ['an inherited code', Object.create({ code: 'ENOTDIR' }), 'ENOTDIR'],
    ['an array', ['ENOENT'], undefined],
    ['a string', 'ENOENT', undefined],
    ['a number', -2, undefined],
    ['a bigint', -2n, undefined],
    ['a boolean', true, undefined],
    ['a symbol', Symbol('ENOENT'), undefined],
    ['null', null, undefined],
    ['undefined', undefined, undefined],
  ])('reads %s', (_name, value, expected) => {
    expect(errnoCode(value)).toBe(expected)
  })

  it('reads the code of a real filesystem error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-fs-safety-'))
    try {
      let thrown: unknown
      try {
        lstatSync(join(dir, 'missing'))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(errnoCode(thrown)).toBe('ENOENT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('errnoIs', () => {
  it('matches any of the listed codes', () => {
    expect(errnoIs(coded('ENOENT'), 'ENOENT')).toBe(true)
    expect(errnoIs(coded('ELOOP'), 'EEXIST', 'ENOTDIR', 'ELOOP')).toBe(true)
    expect(errnoIs(coded('EACCES'), 'EEXIST', 'ENOTDIR', 'ELOOP')).toBe(false)
    expect(errnoIs(coded('ENOENT'))).toBe(false)
  })

  it('is structural, so a plain record matches and a primitive never does', () => {
    expect(errnoIs({ code: 'ENOENT' }, 'ENOENT')).toBe(true)
    expect(errnoIs('ENOENT', 'ENOENT')).toBe(false)
    expect(errnoIs(null, 'ENOENT')).toBe(false)
    expect(errnoIs(undefined, 'ENOENT')).toBe(false)
    expect(errnoIs(coded(-2), '-2')).toBe(false)
  })

  it('compares codes exactly', () => {
    expect(errnoIs(coded('enoent'), 'ENOENT')).toBe(false)
    expect(errnoIs(coded('ENOENT '), 'ENOENT')).toBe(false)
    expect(errnoIs(coded(''), '')).toBe(true)
  })
})

describe('isInside(root, candidate)', () => {
  it.each<[string, string, boolean]>([
    ['/repo', '/repo', true],
    ['/repo', '/repo/src', true],
    ['/repo', '/repo/src/deep/file', true],
    ['/repo', '/repo/..b', true],
    ['/repo', '/repo2', false],
    ['/repo', '/rep', false],
    ['/repo', '/repo..b', false],
    ['/repo', '/', false],
    ['/repo/src', '/repo', false],
    ['/repo', '/other/repo', false],
    ['/', '/', true],
    ['/', '/repo', true],
    ['/', '/repo/src', true],
  ])('isInside(%j, %j) is %s for canonical paths', (root, candidate, expected) => {
    expect(isInside(root, candidate)).toBe(expected)
  })

  it.each<[string, string, boolean]>([
    ['/repo', '/repo/../etc', true],
    ['/repo', '/repo/', true],
    ['/repo/', '/repo/src', false],
    ['/repo/', '/repo', false],
    ['/', 'relative', false],
  ])('does not normalize: isInside(%j, %j) is %s', (root, candidate, expected) => {
    expect(isInside(root, candidate)).toBe(expected)
  })
})

describe('isOwnerPrivate(stat, uid)', () => {
  const owner = 501
  it.each(octal([0o000, 0o100, 0o200, 0o400, 0o500, 0o600, 0o700]))(
    'accepts owner-only permission bits %s',
    (_name, bits) => {
      expect(isOwnerPrivate({ uid: owner, mode: 0o100000 | bits }, owner)).toBe(true)
      expect(isOwnerPrivate({ uid: owner, mode: 0o040000 | bits }, owner)).toBe(true)
    },
  )

  it.each(octal([0o040, 0o020, 0o010, 0o004, 0o002, 0o001, 0o077, 0o644, 0o755, 0o777]))(
    'refuses any group or other bit in %s',
    (_name, bits) => {
      expect(isOwnerPrivate({ uid: owner, mode: 0o100000 | bits }, owner)).toBe(false)
    },
  )

  it('refuses another owner, and an unknown uid whatever the stat says', () => {
    expect(isOwnerPrivate({ uid: owner + 1, mode: 0o100600 }, owner)).toBe(false)
    expect(isOwnerPrivate({ uid: 0, mode: 0o100600 }, owner)).toBe(false)
    expect(isOwnerPrivate({ uid: owner, mode: 0o100600 }, undefined)).toBe(false)
    expect(isOwnerPrivate({ uid: 0, mode: 0o100600 }, undefined)).toBe(false)
  })

  it('treats uid 0 as a known owner', () => {
    expect(isOwnerPrivate({ uid: 0, mode: 0o040700 }, 0)).toBe(true)
    expect(isOwnerPrivate({ uid: 0, mode: 0o040750 }, 0)).toBe(false)
  })

  it('reads a real lstat result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-fs-safety-'))
    const file = join(dir, 'private')
    const uid = process.getuid?.()
    try {
      writeFileSync(file, '', { mode: 0o600 })
      chmodSync(file, 0o600)
      expect(isOwnerPrivate(lstatSync(file), uid)).toBe(uid !== undefined)
      chmodSync(file, 0o640)
      expect(isOwnerPrivate(lstatSync(file), uid)).toBe(false)
      expect(isOwnerPrivate(lstatSync(file), undefined)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
