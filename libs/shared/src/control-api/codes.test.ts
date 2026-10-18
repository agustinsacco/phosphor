import { describe, expect, it } from 'vitest'
import * as facade from '../control-api'
import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  formatUserCode,
  normalizeUserCode,
  userCodeFromBytes,
} from './codes'

describe('user codes', () => {
  it('gives every letter the same share of the accepted bytes', () => {
    const counts = new Map<string, number>()
    for (let byte = 0; byte < 256; byte++) {
      const letter = userCodeFromBytes(new Uint8Array(USER_CODE_LENGTH).fill(byte))?.[0]
      if (letter !== undefined) counts.set(letter, (counts.get(letter) ?? 0) + 1)
    }
    expect([...counts.keys()].sort().join('')).toBe(USER_CODE_ALPHABET)
    expect(new Set(counts.values())).toEqual(new Set([12]))
  })

  it('skips rejected bytes without consuming a letter and needs eight accepted bytes', () => {
    const accepted = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    const mixed = Uint8Array.from([240, 0, 255, 1, 2, 3, 4, 248, 5, 6, 7, 9])
    expect(userCodeFromBytes(mixed)).toBe(userCodeFromBytes(accepted))
    expect(userCodeFromBytes(accepted.subarray(1))).toBeNull()
    expect(userCodeFromBytes(new Uint8Array(64).fill(240))).toBeNull()
  })

  it('normalizes what a person typed back to the generated code', () => {
    const code = userCodeFromBytes(Uint8Array.from([19, 0, 8, 13, 3, 11, 5, 16]))
    expect(code).toBe('ZBLRFPHV')
    expect(formatUserCode('ZBLRFPHV')).toBe('ZBLR-FPHV')
    for (const typed of ['ZBLR-FPHV', 'zblr-fphv', ' zblr fphv ', 'ZB-LR-FP-HV', 'Zblr\tFphv'])
      expect(normalizeUserCode(typed)).toBe('ZBLRFPHV')
    for (const typed of ['ZBLR-FPH', 'ZBLR-FPHVB', 'ZBLR_FPHV', 'ZBLR-FPH0', 'ABLR-FPHV'])
      expect(normalizeUserCode(typed)).toBeNull()
    expect(normalizeUserCode(`${' '.repeat(24)}ZBLRFPHV`)).toBe('ZBLRFPHV')
    expect(normalizeUserCode(`${' '.repeat(25)}ZBLRFPHV`)).toBeNull()
    for (const typed of [undefined, null, 12345678, ['ZBLRFPHV'], { code: 'ZBLRFPHV' }])
      expect(normalizeUserCode(typed)).toBeNull()
  })

  it('is what the control-api entry exports', () => {
    expect(facade.USER_CODE_ALPHABET).toBe(USER_CODE_ALPHABET)
    expect(facade.USER_CODE_LENGTH).toBe(USER_CODE_LENGTH)
    expect(facade.userCodeFromBytes).toBe(userCodeFromBytes)
    expect(facade.formatUserCode).toBe(formatUserCode)
    expect(facade.normalizeUserCode).toBe(normalizeUserCode)
  })
})
