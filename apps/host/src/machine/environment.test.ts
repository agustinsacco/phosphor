import { describe, expect, it } from 'vitest'
import { buildPiEnvironment, passRefusal, platformPath, redact } from './environment'

const SECRET = 'sk-ant-test-0123456789'
const host = {
  HOME: '/home/me',
  USER: 'me',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  TERM: 'xterm-256color',
  PATH: '.:/tmp:/usr/bin',
  NODE_OPTIONS: '--require=/tmp/hook.js',
  LD_PRELOAD: '/tmp/hook.so',
  DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
  BASH_ENV: '/tmp/hook.sh',
  PROMPT_COMMAND: 'curl example.invalid',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  ANTHROPIC_API_KEY: SECRET,
  aws_profile: 'work-account',
  PI_CODING_AGENT_DIR: '/home/me/.pi/agent',
  GH_TOKEN: 'ghp_0123456789abcdef',
  DATABASE_URL: 'postgres://me:hunter22@db/app',
  RANDOM_THING: 'x',
}
const LINUX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin'

describe("pi's environment", () => {
  it('never passes a loader or shell hook, or the inherited PATH, even when named', () => {
    const { env, names } = buildPiEnvironment({
      hostEnv: host,
      pass: ['NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'PATH'],
      platform: 'linux',
    })
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV']) {
      expect(names).not.toContain(name)
    }
    expect(names).not.toContain('PROMPT_COMMAND')
    expect(env.PATH).toBe(`/home/me/.local/bin:${LINUX_PATH}`)
  })

  it('passes identity, locale and provider names, and nothing else unless named', () => {
    const plain = buildPiEnvironment({ hostEnv: host, platform: 'linux' })
    expect(plain.names).toEqual([
      'ANTHROPIC_API_KEY',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'PI_CODING_AGENT_DIR',
      'USER',
      'aws_profile',
    ])
    expect(plain.ambient).toEqual([])

    const named = buildPiEnvironment({
      hostEnv: host,
      pass: ['SSH_AUTH_SOCK', 'GH_TOKEN', 'NOT_SET'],
      platform: 'linux',
    })
    expect(named.names).toEqual(expect.arrayContaining(['SSH_AUTH_SOCK', 'GH_TOKEN']))
    expect(named.names).not.toContain('TERM')
    expect(named.ambient).toEqual(['SSH_AUTH_SOCK'])
    expect(named.unset).toEqual(['NOT_SET'])
  })

  it("builds PATH from node's folder, then the config, then the platform defaults", () => {
    const { env } = buildPiEnvironment({
      hostEnv: host,
      nodePath: '/opt/node/bin/node',
      path: ['/home/me/.cargo/bin', '/usr/bin'],
      platform: 'darwin',
    })
    expect(env.PATH).toBe(
      '/opt/node/bin:/home/me/.cargo/bin:/usr/bin:/home/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
    )
    expect(platformPath('linux').join(':')).toBe(LINUX_PATH)
  })

  it('treats credential, provider and passed values as secrets, but not pi paths or short values', () => {
    const { secrets } = buildPiEnvironment({
      hostEnv: { ...host, OPENAI_API_KEY: 'short' },
      pass: ['GH_TOKEN', 'DATABASE_URL'],
      platform: 'linux',
    })
    expect([...secrets].sort()).toEqual(
      [SECRET, 'ghp_0123456789abcdef', 'postgres://me:hunter22@db/app', 'work-account'].sort(),
    )
    expect(secrets.map((secret) => secret.length)).toEqual(
      [...secrets.map((secret) => secret.length)].sort((a, b) => b - a),
    )
  })
})

describe('redaction', () => {
  it('replaces every occurrence, whatever the order of the secrets', () => {
    const secrets = buildPiEnvironment({
      hostEnv: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET.slice(0, 11) },
      platform: 'linux',
    }).secrets
    expect(redact(`a ${SECRET} b ${SECRET.slice(0, 11)} c ${SECRET}`, secrets)).toBe(
      'a [redacted] b [redacted] c [redacted]',
    )
  })

  it('hides overlapping secrets whole, so no fragment of either survives', () => {
    // Replacing one secret at a time would leave the end of the other behind.
    for (const secrets of [
      ['abcdef12', 'ef123456'],
      ['ef123456', 'abcdef12'],
    ]) {
      expect(redact('x abcdef123456 y', secrets)).toBe('x [redacted] y')
    }
    expect(redact(`${SECRET}${SECRET} and ${SECRET}`, [SECRET])).toBe('[redacted] and [redacted]')
    expect(redact('nothing here', [SECRET, ''])).toBe('nothing here')
  })

  it('hides the start of a secret at the end of text that was cut short', () => {
    const cutOff = `log ${SECRET.slice(0, 10)}`
    expect(redact(cutOff, [SECRET], true)).toBe('log [redacted]')
    // Text that ended by itself keeps its last word: only exact values are secret.
    expect(redact(cutOff, [SECRET])).toBe(cutOff)
    expect(redact(`log ${SECRET}`, [SECRET], true)).toBe('log [redacted]')
  })

  it('hides exactly what a check of every position would, cut short or not', () => {
    // Slow and plainly correct: try every position, and every start of each secret.
    const reference = (text: string, secrets: string[], cut: boolean) => {
      const hidden: boolean[] = new Array<boolean>(text.length).fill(false)
      const mark = (from: number, to: number) => hidden.fill(true, from, to)
      for (const secret of secrets) {
        for (let at = 0; at + secret.length <= text.length; at++) {
          if (text.startsWith(secret, at)) mark(at, at + secret.length)
        }
        for (let length = Math.min(secret.length - 1, text.length); cut && length > 0; length--) {
          if (text.endsWith(secret.slice(0, length))) {
            mark(text.length - length, text.length)
            break
          }
        }
      }
      return [...text].map((char, i) => (!hidden[i] ? char : hidden[i - 1] ? '' : '[redacted]'))
    }
    const mismatches: string[] = []
    const check = (text: string, secrets: string[]) => {
      for (const cut of [false, true]) {
        if (redact(text, secrets, cut) !== reference(text, secrets, cut).join('')) {
          mismatches.push(JSON.stringify({ text, secrets, cut }))
        }
      }
    }
    // The start that ends the text overlaps the occurrence before it: aab after aabaaa.
    check('aabaaab', ['aabaaa'])
    // Every secret over two letters up to 6 long, in every text up to 9 long.
    const words = (length: number): string[] =>
      length === 0 ? [''] : words(length - 1).flatMap((word) => [`${word}a`, `${word}b`])
    const texts = Array.from({ length: 10 }, (_, length) => words(length)).flat()
    for (let length = 1; length <= 6; length++) {
      for (const secret of words(length)) for (const text of texts) check(text, [secret])
    }
    // Several secrets at once, in texts made of pieces of them. xorshift32: a fixed sequence.
    let state = 2463534242
    const random = (below: number) => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % below
    }
    const word = (length: number) => Array.from({ length }, () => 'ab'[random(2)]).join('')
    for (let run = 0; run < 2000; run++) {
      const secrets = Array.from({ length: 2 + random(2) }, () => word(1 + random(8)))
      let text = ''
      for (let piece = random(7); piece > 0; piece--) {
        const source = random(3) === 0 ? word(1 + random(3)) : secrets[random(secrets.length)]!
        const from = random(source.length)
        text += source.slice(from, from + 1 + random(source.length))
      }
      check(text, secrets)
    }
    expect(mismatches.length, mismatches.slice(0, 5).join('\n')).toBe(0)
  })

  it('stays linear however the text and the secret repeat', () => {
    // Searching position by position, each of these compares about a billion characters.
    const started = performance.now()
    const secret = 'a'.repeat(131_072)
    // No start of the secret ends text that ends in b.
    const near = `${'a'.repeat(65_535)}b`
    expect(redact(near, [secret], true)).toBe(near)
    // Here the cut kept the secret's first 65,535 characters.
    expect(redact(`b${'a'.repeat(65_535)}`, [secret], true)).toBe('b[redacted]')
    expect(redact('a'.repeat(65_536), ['a'.repeat(32_768)])).toBe('[redacted]')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('says why the config may not pass a name', () => {
    expect(passRefusal('PATH')).toContain('/environment/path')
    expect(passRefusal('ld_library_path')).toBe('ld_library_path is never passed to pi')
    expect(passRefusal('GH_TOKEN')).toBeNull()
  })
})

it.each(['linux', 'darwin'] as const)(
  'finds later ~/.local/bin installs on %s after configured paths',
  (platform) => {
    const path = buildPiEnvironment({
      hostEnv: { HOME: '/home/test' },
      path: ['/custom'],
      platform,
    }).env.PATH?.split(':')
    expect(path?.slice(0, 2)).toEqual(['/custom', '/home/test/.local/bin'])
    expect(path).toContain('/usr/bin')
  },
)
