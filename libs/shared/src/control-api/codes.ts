/**
 * Enrollment user codes: generated from random bytes, shown in two groups and
 * normalized from what a person typed. No crypto here: callers supply bytes.
 */

/** No vowels (no words), no 0/O/1/I look-alikes. 20 letters, 8 of them: ~2.6e10. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const USER_CODE_LENGTH = 8

/**
 * A code from random bytes by rejection sampling (bytes >= 240 are skipped, so
 * every letter is equally likely). Returns null when the bytes run out; 32
 * bytes fail with probability below 1e-20.
 */
export function userCodeFromBytes(bytes: Uint8Array): string | null {
  let code = ''
  for (const byte of bytes) {
    if (byte >= 240) continue
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
    if (code.length === USER_CODE_LENGTH) return code
  }
  return null
}

/** BCDFGHJK → BCDF-GHJK, for display. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * What a person typed → the canonical 8 letters, or null. Case, spaces and
 * dashes are forgiven; anything else is not. Hash this value, never the input.
 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== USER_CODE_LENGTH) return null
  for (const char of code) if (!USER_CODE_ALPHABET.includes(char)) return null
  return code
}
