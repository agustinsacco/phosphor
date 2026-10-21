import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSessionRequest } from './request'

const OUTSIDE_ROOTS = 'must be an existing folder inside a configured repository'
let dir: string
let repo: string
let session: string
const parse = (request: unknown, options?: { deleting?: boolean }) =>
  parseSessionRequest(request, [repo], options)
const errors = async (request: unknown) => {
  const parsed = await parse(request)
  expect(parsed.ok).toBe(false)
  return parsed.ok ? [] : parsed.errors
}

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-request-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  repo = join(dir, 'repo')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(join(dir, 'repo2'))
  mkdirSync(sessionDirForCwd(repo), { recursive: true })
  session = join(sessionDirForCwd(repo), '2026-10-09T10-00-00-000Z_abc.jsonl')
  writeFileSync(session, '{"type":"session"}\n')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('a session request', () => {
  it('starts in a folder inside a repository, with checked values', async () => {
    const request = {
      repository: join(repo, 'sub'),
      provider: 'anthropic',
      model: 'anthropic/claude-opus-5:high',
      thinkingLevel: 'high',
      name: 'Fix the build',
    }
    expect(await parse(request)).toEqual({
      ok: true,
      options: {
        workspacePath: join(repo, 'sub'),
        provider: 'anthropic',
        model: 'anthropic/claude-opus-5:high',
        thinkingLevel: 'high',
        name: 'Fix the build',
      },
    })
  })

  it("resumes a file in pi's session folder for that repository, by its real path", async () => {
    expect(await parse({ repository: repo, sessionPath: session })).toEqual({
      ok: true,
      options: { workspacePath: repo, sessionPath: session },
    })
    // A folder on the way may be a link; the file itself may not.
    symlinkSync(sessionDirForCwd(repo), join(dir, 'sessions-link'))
    const linked = join(dir, 'sessions-link', '2026-10-09T10-00-00-000Z_abc.jsonl')
    expect(await parse({ repository: repo, sessionPath: linked })).toMatchObject({
      ok: true,
      options: { sessionPath: session },
    })
  })

  it.each([null, [], 'repo', 7])('refuses %j, which is not an object', async (request) => {
    expect(await errors(request)).toEqual([{ pointer: '', message: 'must be an object' }])
  })

  it("refuses the spawn controls the Host sets, and fields it doesn't know, all at once", async () => {
    const owned = [
      'env',
      'binaryPath',
      'prefixArgs',
      'extensions',
      'appendSystemPrompt',
      'cwd',
      'forkFrom',
      'sessionId',
    ]
    const request = {
      repository: repo,
      colour: 'red',
      ...Object.fromEntries(owned.map((k) => [k, 'x'])),
    }
    expect(await errors(request)).toEqual([
      { pointer: '/colour', message: 'is not a request field' },
      ...owned.map((key) => ({
        pointer: `/${key}`,
        message: 'is set by the Host, never by a request',
      })),
    ])
  })

  it.each([
    ['missing', undefined, 'is required'],
    ['not a string', 7, 'must be a string'],
    ['relative', 'repo', 'must be an absolute path'],
    ['the folder above it', '{dir}', 'must be an existing folder inside a configured repository'],
    [
      'a sibling sharing its prefix',
      '{dir}/repo2',
      'must be an existing folder inside a configured repository',
    ],
    [
      '.. out of it',
      '{dir}/repo/../repo2',
      'must be an existing folder inside a configured repository',
    ],
    [
      'a symlink out of it',
      '{dir}/repo/escape',
      'must be an existing folder inside a configured repository',
    ],
    [
      'missing on disk',
      '{dir}/repo/gone',
      'must be an existing folder inside a configured repository',
    ],
    ['a file inside it', '{dir}/repo/file.txt', 'must be a folder'],
  ])('refuses a repository that is %s', async (_what, value, message) => {
    symlinkSync(join(dir, 'repo2'), join(repo, 'escape'))
    writeFileSync(join(repo, 'file.txt'), '')
    const repository = typeof value === 'string' ? value.replace('{dir}', dir) : value
    expect(await errors(repository === undefined ? {} : { repository })).toEqual([
      { pointer: '/repository', message },
    ])
  })

  it.each([
    ['relative', 'session.jsonl', 'must be an absolute path'],
    ['not a .jsonl', '{folder}/notes.txt', 'must name a .jsonl file'],
    ['only an extension', '{folder}/.jsonl', 'must name a .jsonl file'],
    ['missing', '{folder}/gone.jsonl', 'does not exist'],
    ['a symlink to a session', '{folder}/link.jsonl', 'must not be a symlink'],
    ['a folder', '{folder}/folder.jsonl', 'must be a file'],
    [
      'in the repository',
      '{dir}/repo/notes.jsonl',
      "must be in pi's session folder for this repository",
    ],
    [
      'in another folder of pi',
      '{other}/x.jsonl',
      "must be in pi's session folder for this repository",
    ],
    [
      'in the folder of a subfolder',
      '{sub}/x.jsonl',
      "must be in pi's session folder for this repository",
    ],
    [
      'in a folder inside it',
      '{folder}/nested/x.jsonl',
      "must be in pi's session folder for this repository",
    ],
    [
      'missing, outside it',
      '{dir}/repo/gone.jsonl',
      "must be in pi's session folder for this repository",
    ],
  ])('only resumes a session file of pi: not one that is %s', async (_what, value, message) => {
    const folder = sessionDirForCwd(repo)
    const other = sessionDirForCwd(join(dir, 'repo2'))
    const sub = sessionDirForCwd(join(repo, 'sub'))
    for (const made of [other, sub, join(folder, 'folder.jsonl'), join(folder, 'nested')]) {
      mkdirSync(made, { recursive: true })
    }
    const files = [join(other, 'x.jsonl'), join(sub, 'x.jsonl'), join(repo, 'notes.jsonl')]
    for (const file of [...files, join(folder, 'nested/x.jsonl')]) {
      writeFileSync(file, '{}\n')
    }
    writeFileSync(join(folder, 'notes.txt'), '')
    writeFileSync(join(folder, '.jsonl'), '')
    symlinkSync(session, join(folder, 'link.jsonl'))
    const sessionPath = value
      .replace('{folder}', folder)
      .replace('{other}', other)
      .replace('{sub}', sub)
      .replace('{dir}', dir)
    expect(await errors({ repository: repo, sessionPath })).toEqual([
      { pointer: '/sessionPath', message },
    ])
  })

  it('deletes by a repository and a session file, both required, and nothing else', async () => {
    expect(await parse({ repository: repo, sessionPath: session }, { deleting: true })).toEqual({
      ok: true,
      options: { workspacePath: repo, sessionPath: session },
    })
    expect(await parse({ repository: repo, name: 'x' }, { deleting: true })).toEqual({
      ok: false,
      errors: [
        { pointer: '/name', message: 'is not a request field' },
        { pointer: '/sessionPath', message: 'is required' },
      ],
    })
    // Refused once, whatever the value: it is not read as a name.
    const extra = { repository: repo, sessionPath: session, name: '-x', model: 7 }
    expect(await parse(extra, { deleting: true })).toEqual({
      ok: false,
      errors: [
        { pointer: '/name', message: 'is not a request field' },
        { pointer: '/model', message: 'is not a request field' },
      ],
    })
  })

  it('deletes the session of a worktree removed outside Phosphor, but never starts one', async () => {
    // A lane whose worktree folder was removed by hand must still be deletable.
    const gone = join(repo, '.phosphor', 'worktrees', 'removed')
    mkdirSync(sessionDirForCwd(gone), { recursive: true })
    const orphan = join(sessionDirForCwd(gone), '2026-10-09T10-00-00-000Z_def.jsonl')
    writeFileSync(orphan, '{"type":"session"}\n')
    expect(await parse({ repository: gone, sessionPath: orphan }, { deleting: true })).toEqual({
      ok: true,
      options: { workspacePath: gone, sessionPath: orphan },
    })
    const missing = { pointer: '/repository', message: OUTSIDE_ROOTS }
    expect(await errors({ repository: gone, sessionPath: orphan })).toEqual([missing])
    // A removed folder still has to be inside a configured repository.
    const outside = join(dir, 'repo2', 'removed')
    expect(await parse({ repository: outside, sessionPath: orphan }, { deleting: true })).toEqual({
      ok: false,
      errors: [missing],
    })
  })

  it('counts a field set to undefined, or carried by a prototype, as missing', async () => {
    const inherited = Object.create({ repository: repo, sessionPath: session }) as object
    for (const request of [{ repository: undefined }, inherited]) {
      expect(await parse(request, { deleting: true })).toEqual({
        ok: false,
        errors: [
          { pointer: '/repository', message: 'is required' },
          { pointer: '/sessionPath', message: 'is required' },
        ],
      })
    }
  })

  it('refuses values that could become a flag or break a line, and never repeats one', async () => {
    const request = {
      repository: repo,
      provider: '--extension',
      model: '--extension=/tmp/x.ts',
      thinkingLevel: 'extreme',
      name: '-n evil',
    }
    const found = await errors(request)
    expect(found.map((error) => error.pointer)).toEqual([
      '/provider',
      '/model',
      '/thinkingLevel',
      '/name',
    ])
    expect(found[2]!.message).toBe('must be one of off, minimal, low, medium, high, xhigh, max')
    expect(JSON.stringify(found)).not.toMatch(/extension|extreme|evil/)
  })

  it.each([
    ['provider', 'x'.repeat(65)],
    ['provider', 'pi claude'],
    ['model', 'claude opus'],
    ['model', `m${'x'.repeat(128)}`],
    ['name', ''],
    ['name', 'x'.repeat(121)],
    ['name', 'two\nlines'],
    ['name', 'next\u0085line'],
    ['name', 'bell\u0007'],
    ['name', 'line\u2028separator'],
    ['name', 'right\u202Eto left'],
    ['name', 'isolate\u2066d'],
  ])('refuses the %s %j', async (key, value) => {
    expect((await errors({ repository: repo, [key]: value })).map((e) => e.pointer)).toEqual([
      `/${key}`,
    ])
  })

  it.each([
    ['provider', 'pi-claude-cli'],
    ['model', 'us.anthropic.claude-opus-5@2026+exp'],
    ['name', 'x'.repeat(120)],
    ['name', 'Café: résumé, ok'],
  ])('accepts the %s %j', async (key, value) => {
    expect(await parse({ repository: repo, [key]: value })).toMatchObject({
      ok: true,
      options: { [key]: value },
    })
  })
})
