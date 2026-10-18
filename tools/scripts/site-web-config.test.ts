import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { validateWebSessionKeys, webEnabled } from './site-web-config.mjs'

const key = (id = 'current') => `${id}=${randomBytes(32).toString('base64url')}`

describe('site-web-config', () => {
  it('defaults off and admits only exact boolean strings', () => {
    for (const value of [undefined, '', 'false']) expect(webEnabled(value)).toBe(false)
    expect(webEnabled('true')).toBe(true)
    for (const value of ['TRUE', 'False', '1', '0', 'yes', ' true', 'true\n', 'false '])
      expect(() => webEnabled(value)).toThrow('PHOSPHOR_WEB_ENABLED must be true or false')
  })

  it('admits one to eight canonical 32-byte keys with unique bounded ids', () => {
    expect(() => validateWebSessionKeys(key())).not.toThrow()
    expect(() =>
      validateWebSessionKeys(Array.from({ length: 8 }, (_, i) => key(`k-${i}_`)).join(',')),
    ).not.toThrow()
    expect(() => validateWebSessionKeys(key('k'.repeat(64)))).not.toThrow()
    const encoded = randomBytes(32).toString('base64url')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const noncanonical = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1]
    for (const value of [
      '',
      'x'.repeat(4097),
      Array.from({ length: 9 }, (_, i) => key(`k${i}`)).join(','),
      `${key()},${key()}`,
      key(''),
      key('k'.repeat(65)),
      key('bad.id'),
      key('bad\n'),
      key('é'),
      key() + ',',
      key() + '=',
      key() + '\n',
      key() + ' ',
      `k=${randomBytes(31).toString('base64url')}`,
      `k=${randomBytes(33).toString('base64url')}`,
      `k=${noncanonical}`,
    ])
      expect(() => validateWebSessionKeys(value)).toThrow(
        'Invalid or missing CONTROL_WEB_SESSION_KEYS',
      )
  })

  it('CLI never emits key material and checks keys only when enabled', () => {
    const secret = key()
    for (const [flag, keys, code] of [
      ['true', secret, 0],
      ['true', secret + '=', 1],
      ['true', '', 1],
      ['false', 'not-a-key', 0],
      ['', '', 0],
      ['TRUE', secret, 1],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        ['tools/scripts/site-web-config.mjs', '--require-keys'],
        {
          encoding: 'utf8',
          env: { PHOSPHOR_WEB_ENABLED: flag, CONTROL_WEB_SESSION_KEYS: keys },
        },
      )
      expect(result.status).toBe(code)
      expect(result.stdout + result.stderr).not.toContain(secret)
      expect(result.stdout + result.stderr).not.toContain(Buffer.from(secret).toString('base64'))
    }
  })
})
