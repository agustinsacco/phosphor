import { describe, expect, it } from 'vitest'
import * as facade from '../host-protocol'
import {
  cursor,
  frameId,
  hex,
  integer,
  isLaneBranchName,
  label,
  member,
  readJson,
  record,
  text,
  utf8Length,
} from './primitives'

const EPOCH = '0123456789abcdef'

describe('host-protocol primitives', () => {
  it('counts UTF-8 bytes as Buffer does, three for each lone surrogate', () => {
    const samples = ['', 'ASCII', 'é', '中', '😀', '\ud800', '\udc00', '\udc00\ud800', 'a\ud83d']
    for (const s of [...samples, '\ud800\ud800\udc00', '😀'.slice(1) + '😀'])
      expect(utf8Length(s), JSON.stringify(s)).toBe(Buffer.byteLength(s))
    expect(utf8Length('\ud800'.repeat(4))).toBe(12)
    expect(utf8Length('😀'.repeat(4))).toBe(16)
  })

  it('accepts only safe integers at or above the minimum', () => {
    for (const v of [0, 1, Number.MAX_SAFE_INTEGER]) expect(integer(v)).toBe(true)
    const unsafe = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined]
    for (const v of unsafe) expect(integer(v), String(v)).toBe(false)
    expect(integer(0, 1)).toBe(false)
    expect(integer(1, 1)).toBe(true)
  })

  it('bounds text by UTF-16 length and checks records, members and ids', () => {
    expect(text('é'.repeat(5), 5)).toBe(true)
    expect(text('😀'.repeat(3), 5)).toBe(false)
    expect([text('', 1), text('', 1, 0), text('ab', 1), text(1, 5)]).toEqual([
      false,
      true,
      false,
      false,
    ])
    expect([record({}), record([]), record(null), record('x')]).toEqual([true, false, false, false])
    expect([member('a', ['a', 'b']), member('c', ['a']), member(1, ['1'])]).toEqual([
      true,
      false,
      false,
    ])
    for (const v of [EPOCH.toUpperCase(), EPOCH.slice(1), EPOCH + '0', 1])
      expect(hex(v)).toBe(false)
    expect(hex(EPOCH)).toBe(true)
    expect([frameId('a-b_C9'), frameId('x'.repeat(64)), frameId('x'.repeat(65))]).toEqual([
      true,
      true,
      false,
    ])
    for (const v of ['', 'a.b', 'a/b', 'a b', 1]) expect(frameId(v)).toBe(false)
  })

  it('takes labels only in their normalized form', () => {
    for (const v of ['Desktop', 'x'.repeat(80), 'A b']) expect(label(v)).toBe(true)
    for (const v of ['', ' Desktop', 'Desktop ', 'x'.repeat(81), 'a\u202eb', 'a\nb', 1])
      expect(label(v)).toBe(false)
  })

  it('projects cursors and refuses a seq below the minimum', () => {
    expect(cursor({ epoch: EPOCH, seq: 0, extra: 1 })).toStrictEqual({ epoch: EPOCH, seq: 0 })
    expect(cursor({ epoch: EPOCH, seq: 0 }, 1)).toBeNull()
    expect(cursor({ epoch: EPOCH, seq: 1 }, 1)).toStrictEqual({ epoch: EPOCH, seq: 1 })
    for (const v of [null, [], { epoch: 'x', seq: 0 }, { epoch: EPOCH, seq: 0.5 }])
      expect(cursor(v)).toBeNull()
  })

  it('reads bounded JSON objects, checking bytes before parsing', () => {
    expect(readJson('{"a":1}', 7)).toStrictEqual({ ok: true, value: { a: 1 } })
    expect(readJson('{"a":1}', 6)).toStrictEqual({ ok: false, reason: 'frame-size' })
    expect(readJson('{"a":"é"}', 9)).toStrictEqual({ ok: false, reason: 'frame-size' })
    expect(readJson('{"a":"é"}', 10)).toStrictEqual({ ok: true, value: { a: 'é' } })
    expect(readJson('{"a":"\ud800"}', 10)).toStrictEqual({ ok: false, reason: 'frame-size' })
    expect(readJson('{"a":"\ud800"}', 11)).toStrictEqual({ ok: true, value: { a: '\ud800' } })
    expect(readJson('{', 0)).toStrictEqual({ ok: false, reason: 'frame-size' })
    expect(readJson('{', 1)).toStrictEqual({ ok: false, reason: 'json' })
    for (const s of ['[]', 'null', '1', '"x"'])
      expect(readJson(s, 10)).toStrictEqual({ ok: false, reason: 'object' })
  })

  it('enforces each narrowed branch rule, 200 vs 201 characters', () => {
    for (const branch of ['main', 'feature/topic', 'a.b', 'a-b/c_d', 'x'.repeat(200)])
      expect(isLaneBranchName(branch), branch).toBe(true)
    const refused = ['', 'x'.repeat(201), 'a b', 'a\x7fb', 'é', 'a~b', 'a^b', 'a:b', 'a?b']
    for (const branch of [...refused, 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b', '@', '-a', '/a'])
      expect(isLaneBranchName(branch), branch).toBe(false)
    for (const branch of ['a/', 'a//b', '.a', 'a/.b', 'a.lock', 'a/b.lock', 'a.', 1, null])
      expect(isLaneBranchName(branch), String(branch)).toBe(false)
  })

  it('are what the public entry exports', () => {
    expect(facade.utf8Length).toBe(utf8Length)
    expect(facade.isLaneBranchName).toBe(isLaneBranchName)
  })
})
