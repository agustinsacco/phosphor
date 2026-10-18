import { expect, it } from 'vitest'
import { absolutePath, check, integer, text, uuid } from './validation-primitives'
import * as validation from './validation'

const stateError = 'Invalid Host state input.'

it('re-exports the same primitive functions through validation', () => {
  expect(validation.check).toBe(check)
  expect(validation.uuid).toBe(uuid)
  expect(validation.integer).toBe(integer)
  expect(validation.text).toBe(text)
  expect(validation.absolutePath).toBe(absolutePath)
})

it('check accepts true and throws the shared error for false', () => {
  expect(check(true)).toBeUndefined()
  expect(() => check(false)).toThrow(stateError)
})

it('uuid accepts lowercase supported versions and rejects malformed or unsupported ids', () => {
  for (const value of [
    '00000000-0000-1000-8000-000000000000',
    'ffffffff-ffff-8fff-bfff-ffffffffffff',
  ])
    expect(uuid(value)).toBeUndefined()
  for (const value of [
    '',
    'bad',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-9000-8000-000000000000',
    '00000000-0000-1000-7000-000000000000',
    'FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF',
    '00000000-0000-1000-8000-000000000000\n',
  ])
    expect(() => uuid(value)).toThrow(stateError)
})

it('integer checks safe integer boundaries with default and explicit minima', () => {
  for (const value of [0, -0, 1, Number.MAX_SAFE_INTEGER]) expect(integer(value)).toBeUndefined()
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => integer(value)).toThrow(stateError)
  expect(integer(1, 1)).toBeUndefined()
  expect(() => integer(0, 1)).toThrow(stateError)
  expect(integer(Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER)).toBeUndefined()
  expect(() => integer(Number.MIN_SAFE_INTEGER - 1, Number.MIN_SAFE_INTEGER - 1)).toThrow(
    stateError,
  )
})

it('text checks nullable values, UTF-16 length, empty policy and forbidden characters', () => {
  for (const value of [null, 'a', 'ab', 'é', '😀', ' ', '\u0080'])
    expect(text(value, 2)).toBeUndefined()
  expect(text('', 0, true)).toBeUndefined()
  expect(text(null, 0)).toBeUndefined()
  for (const value of ['', 'abc', '\0', '\x1f', '\x7f', '\u2028', '\u2029'])
    expect(() => text(value, 2)).toThrow(stateError)
  expect(() => text('😀', 1)).toThrow(stateError)
  expect(() => text('a', 0, true)).toThrow(stateError)
  expect(() => text('\n', 2, true)).toThrow(stateError)
})

it('absolutePath requires normalized absolute paths bounded to 4096 characters', () => {
  for (const value of ['/', '/a', '/a/', '/a b/é', `/${'x'.repeat(4095)}`])
    expect(absolutePath(value)).toBeUndefined()
  for (const value of [
    '',
    'relative',
    './a',
    '/a/../b',
    '/a/./b',
    '/a//b',
    '//a',
    '/a\0b',
    '/a\nb',
    `/${'x'.repeat(4096)}`,
  ])
    expect(() => absolutePath(value)).toThrow(stateError)
})
