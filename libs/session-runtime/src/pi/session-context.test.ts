import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSessionEntries, sessionContext } from './session-context'

const fixtures = fileURLToPath(new URL('./__fixtures__/session-context/', import.meta.url))
const header = { type: 'session', id: 'session', version: 3 }
const entry = (id: string, parentId: string | null = null) => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'user', content: id },
})
const text = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n')

describe('session-context', () => {
  for (const name of readdirSync(fixtures).filter((name) => name.endsWith('.jsonl'))) {
    it(`matches pi 0.87.1 golden ${name}`, () => {
      const input = readFileSync(`${fixtures}/${name}`, 'utf8')
      const entries = parseSessionEntries(input)
      expect(entries).not.toBeNull()
      const golden: unknown = JSON.parse(
        readFileSync(`${fixtures}/${name.replace('.jsonl', '.messages.json')}`, 'utf8'),
      )
      // JSON wire serialization omits undefined fields, just as real pi's RPC does.
      expect(JSON.parse(JSON.stringify(entries && sessionContext(entries)?.messages))).toEqual(
        golden,
      )
      expect(readFileSync(`${fixtures}/${name}`, 'utf8')).toBe(input)
    })
  }
  it('treats a header without a version as version 1, as pi does', () => {
    const input = readFileSync(`${fixtures}/v1.jsonl`, 'utf8').split('\n')
    const first = JSON.parse(input[0] ?? '') as Record<string, unknown>
    expect(first.version).toBe(1)
    delete first.version
    const entries = parseSessionEntries([JSON.stringify(first), ...input.slice(1)].join('\n'))
    const golden: unknown = JSON.parse(readFileSync(`${fixtures}/v1.messages.json`, 'utf8'))
    expect(JSON.parse(JSON.stringify(entries && sessionContext(entries)?.messages))).toEqual(golden)
  })
  it('never converts the timestamp of an entry pi ignores', () => {
    const lines = readFileSync(`${fixtures}/leaf-entries.jsonl`, 'utf8').split('\n')
    const golden: unknown = JSON.parse(
      readFileSync(`${fixtures}/leaf-entries.messages.json`, 'utf8'),
    )
    for (const type of ['label', 'session_info', 'model_change']) {
      const changed = lines.map((line) => {
        if (!line.trim()) return line
        const entry = JSON.parse(line) as Record<string, unknown>
        // An object whose conversion to a primitive throws.
        if (entry.type === type) entry.timestamp = { toString: null, valueOf: null }
        return JSON.stringify(entry)
      })
      const entries = parseSessionEntries(changed.join('\n'))
      expect(JSON.parse(JSON.stringify(entries && sessionContext(entries)?.messages))).toEqual(
        golden,
      )
    }
  })
  it('requires the first parsed entry to be a header with a string id', () => {
    for (const input of [
      '',
      text(entry('a')),
      text(entry('a'), header),
      text({ type: 'session', id: 1 }),
      'null',
      '[]',
    ])
      expect(parseSessionEntries(input)).toBeNull()
    expect(parseSessionEntries(`bad\n\n${text(header)}`)).toEqual([header])
    for (const value of [1, 'truthy', true, []])
      expect(parseSessionEntries(text(header, value))).toBeNull()
  })
  it('skips falsey parsed lines before and after the header without counting them', () => {
    const falsey = [null, false, 0, '']
    expect(
      parseSessionEntries(text(...falsey, header, ...falsey, entry('a'), ...falsey), 2),
    ).toEqual([header, entry('a')])
  })
  it('does not migrate a non-numeric version', () => {
    const entries = [
      { ...header, version: 'x' },
      { ...entry('a'), message: { role: 'hookMessage', content: 'unchanged' } },
    ]
    expect(parseSessionEntries(text(...entries))).toEqual(entries)
  })
  it('uses fresh symbols for v1 ids and compaction references', () => {
    const input = readFileSync(`${fixtures}/v1.jsonl`, 'utf8')
    const entries = parseSessionEntries(input)
    const again = parseSessionEntries(input)
    expect(entries).not.toBeNull()
    const ids = entries?.filter((entry) => entry.type !== 'session').map((entry) => entry.id)
    expect(ids?.every((id) => typeof id === 'symbol')).toBe(true)
    expect(new Set(ids).size).toBe(ids?.length)
    expect(ids?.some((id) => again?.some((entry) => entry.id === id))).toBe(false)
    const compaction = entries?.find((entry) => entry.type === 'compaction')
    expect(typeof compaction?.firstKeptEntryId).toBe('symbol')
    expect(ids).toContain(compaction?.firstKeptEntryId)
  })
  it.each(['custom_message', 'branch_summary', 'compaction'])(
    'uses Date constructor timestamps for %s',
    (type) => {
      for (const [timestamp, expected] of [
        [0, 0],
        [null, 0],
        [undefined, NaN],
        ['2026-01-01T00:00:00.000Z', 1767225600000],
      ]) {
        const messages = sessionContext([
          { type, id: 'a', timestamp, summary: 'summary', customType: 'note', content: 'note' },
        ])?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0]?.timestamp).toBe(expected)
      }
    },
  )
  it('splits on LF only and preserves U+2028 and U+2029', () => {
    const entries = parseSessionEntries(
      text(header, {
        ...entry('a'),
        message: { role: 'user', content: 'one\u2028two\u2029three' },
      }),
    )
    expect(entries).toHaveLength(2)
    expect(entries && sessionContext(entries)?.messages).toEqual([
      { role: 'user', content: 'one\u2028two\u2029three' },
    ])
  })
  it('bounds entries exactly at and one past the limit', () => {
    expect(parseSessionEntries(text(header, entry('a')), 2)).toHaveLength(2)
    expect(parseSessionEntries(text(header, entry('a'), entry('b', 'a')), 2)).toBeNull()
  })
  it('bounds messages exactly at and one past the limit without truncation', () => {
    expect(sessionContext([header, entry('a')], 1)?.messages).toHaveLength(1)
    expect(sessionContext([header, entry('a'), entry('b', 'a')], 1)).toBeNull()
  })
  it('enforces default entry and message caps', () => {
    const entries = Array.from({ length: 200_000 }, (_, i) => ({ type: 'custom', id: String(i) }))
    expect(
      parseSessionEntries(
        [header, ...entries.slice(0, 199_999)].map((e) => JSON.stringify(e)).join('\n'),
      ),
    ).toHaveLength(200_000)
    expect(
      parseSessionEntries(
        [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n'),
      ),
    ).toBeNull()
    const messages = Array.from({ length: 100_001 }, (_, i) =>
      entry(String(i), i ? String(i - 1) : null),
    )
    expect(sessionContext(messages.slice(0, 100_000))?.messages).toHaveLength(100_000)
    expect(sessionContext(messages)).toBeNull()
  })
  it('rejects parent cycles', () => {
    expect(sessionContext([header, entry('a', 'b'), entry('b', 'a')])).toBeNull()
    expect(sessionContext([header, entry('a', 'a')])).toBeNull()
  })
  it('does not mutate entries or message content during projection', () => {
    const entries = [
      header,
      entry('a'),
      {
        type: 'context_edit',
        id: 'b',
        parentId: 'a',
        targetId: 'a',
        replacement: { content: 'new' },
      },
    ]
    const before = structuredClone(entries)
    expect(sessionContext(entries)?.messages).toEqual([{ role: 'user', content: 'new' }])
    expect(entries).toEqual(before)
  })
  it('rejects invalid messages and invalid edits rather than inventing a transcript', () => {
    expect(sessionContext([{ type: 'message', id: 'a', message: null }])).toBeNull()
    expect(sessionContext([{ type: 'message', id: 'a', message: {} }])).toBeNull()
    expect(
      sessionContext([
        entry('a'),
        { type: 'context_edit', id: 'b', parentId: 'a', targetId: 'a', replacement: false },
      ]),
    ).toBeNull()
  })
})

it('generates goldens only from isolated copies, without prompts or temporary paths', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'phosphor-generator-test-'))
  try {
    const bin = join(temporary, 'bin')
    const output = join(temporary, 'fixtures')
    mkdirSync(bin)
    mkdirSync(output)
    symlinkSync(process.execPath, join(bin, 'node'))
    copyFileSync(join(fixtures, 'generate.mjs'), join(output, 'generate.mjs'))
    writeFileSync(
      join(bin, 'pi'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
if (process.argv.includes('--version')) {
  if (process.env.FAIL_SPAWN === '1') fs.unlinkSync(__filename)
  console.log('0.87.1'); process.exit(0)
}
assert.deepEqual(process.argv.slice(2, 5), ['--mode', 'rpc', '--session'])
const session = process.argv[5]
const root = path.dirname(path.dirname(session))
assert.equal(path.dirname(session), path.join(root, 'input'))
assert.equal(process.env.HOME, path.join(root, 'home'))
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, 'agent'))
assert.deepEqual(fs.readdirSync(process.env.PI_CODING_AGENT_DIR), [])
assert.equal(process.cwd(), fs.realpathSync(path.join(root, 'cwd')))
const content = fs.readFileSync(session, 'utf8')
const lines = content.split('\\n')
assert.equal(lines[0], 'bad')
assert.equal(lines[1], '')
assert.deepEqual(lines.slice(2, 6), ['null', 'false', '0', '""'])
assert.equal(fs.realpathSync(JSON.parse(lines[6]).cwd), process.cwd())
assert.equal(lines[7], '{malformed}')
assert.equal(lines.length, 9)
assert.equal(content.endsWith('\\n'), false)
const message = JSON.parse(lines[8]).message
process.stdin.setEncoding('utf8')
process.stdin.once('data', (data) => {
  assert.deepEqual(JSON.parse(data), { id: 'golden', type: 'get_messages' })
  if (message.content === 'move') fs.unlinkSync(session)
  const messages = message.content === 'empty' ? [] : [{ role: 'user',
    content: message.content === 'leak' ? root : message.content === 'tmp' ? '/tmp/leak' : 'golden' }]
  console.log(JSON.stringify({ id: 'golden', success: true, data: { messages } }))
})
`,
      { mode: 0o700 },
    )
    const input = (mode: string) =>
      `bad\n\nnull\nfalse\n0\n""\n${text({ ...header, cwd: '/tmp' })}\n{malformed}\n${text({ ...entry('a'), message: { role: 'user', content: mode } })}`
    const env = { ...process.env, PATH: bin, TMPDIR: temporary }
    writeFileSync(join(output, 'test.jsonl'), input('valid'))
    execFileSync(process.execPath, [join(output, 'generate.mjs')], { env, stdio: 'pipe' })
    expect(JSON.parse(readFileSync(join(output, 'test.messages.json'), 'utf8'))).toEqual([
      { role: 'user', content: 'golden' },
    ])
    for (const mode of ['empty', 'move', 'leak', 'tmp']) {
      rmSync(join(output, 'test.messages.json'))
      writeFileSync(join(output, 'test.jsonl'), input(mode))
      expect(() =>
        execFileSync(process.execPath, [join(output, 'generate.mjs')], { env, stdio: 'pipe' }),
      ).toThrow()
      expect(readdirSync(output)).not.toContain('test.messages.json')
      expect(readdirSync(temporary).sort()).toEqual(['bin', 'fixtures'])
      // Keep an old output ready for the next failure case.
      writeFileSync(join(output, 'test.messages.json'), 'old')
    }
    writeFileSync(join(output, 'test.jsonl'), text(entry('not-a-header')))
    expect(() =>
      execFileSync(process.execPath, [join(output, 'generate.mjs')], { env, stdio: 'pipe' }),
    ).toThrow(/invalid fixture header/)
    expect(readdirSync(temporary).sort()).toEqual(['bin', 'fixtures'])
    writeFileSync(join(output, 'test.jsonl'), 'bad\n\n')
    expect(() =>
      execFileSync(process.execPath, [join(output, 'generate.mjs')], { env, stdio: 'pipe' }),
    ).toThrow(/missing fixture header/)
    expect(readdirSync(temporary).sort()).toEqual(['bin', 'fixtures'])
    writeFileSync(join(output, 'test.jsonl'), input('valid'))
    const failedSpawn = spawnSync(process.execPath, [join(output, 'generate.mjs')], {
      env: { ...env, FAIL_SPAWN: '1' },
      encoding: 'utf8',
      timeout: 2000,
    })
    expect(failedSpawn.status).not.toBe(0)
    expect(failedSpawn.error).toBeUndefined()
    expect(failedSpawn.stderr).toContain('ENOENT')
    expect(readdirSync(temporary).sort()).toEqual(['bin', 'fixtures'])
    expect(readFileSync(join(output, 'test.messages.json'), 'utf8')).toBe('old')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
