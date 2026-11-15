import { describe, expect, it, vi } from 'vitest'
import { isPrRef, parsePrUrl } from '@phosphor/shared/github-pr-refs'
import lanePrs, {
  LANE_PRS_COMMAND,
  LANE_PRS_ENTRY,
  parseLanePrUrl,
  parseLanePrsArgs,
} from './lane-prs'

const URL = 'https://github.com/acme/web/pull/57'
const REF = { host: 'github.com', owner: 'acme', repo: 'web', number: 57 }

function fixture(appendEntry: ((type: string, data: unknown) => void) | null = vi.fn()) {
  let name = ''
  let handler!: (args: string, ctx: unknown) => Promise<void>
  const pi = {
    ...(appendEntry ? { appendEntry } : {}),
    registerCommand: (registered: string, spec: { handler: typeof handler }) => {
      name = registered
      handler = spec.handler
    },
  }
  lanePrs(pi)
  return { name, appendEntry, run: (args: string) => handler(args, {}) }
}

describe('lane PR command', () => {
  it('registers /phosphor-prs and appends exactly { action, ref } as a phosphor-prs entry', async () => {
    const f = fixture()
    expect(f.name).toBe(LANE_PRS_COMMAND)
    expect(LANE_PRS_ENTRY).toBe('phosphor-prs')
    for (const action of ['pin', 'hide', 'clear'] as const) await f.run(`${action} ${URL}`)
    expect(vi.mocked(f.appendEntry!).mock.calls).toEqual([
      [LANE_PRS_ENTRY, { action: 'pin', ref: REF }],
      [LANE_PRS_ENTRY, { action: 'hide', ref: REF }],
      [LANE_PRS_ENTRY, { action: 'clear', ref: REF }],
    ])
  })

  it.each([
    '',
    'pin',
    `track ${URL}`,
    `PIN ${URL}`,
    `pin ${URL} ${URL}`,
    'pin https://github.com/acme/web/issues/57',
    'pin github.com/acme/web/pull/57',
    'pin https://github.com/acme/web/pull/0',
    'pin https://github.com/acme/../pull/5',
    'pin https://localhost/acme/web/pull/5',
  ])('rejects %j without writing', async (args) => {
    const f = fixture()
    await expect(f.run(args)).rejects.toThrow(/phosphor-prs|Not a pull request URL/)
    expect(f.appendEntry).not.toHaveBeenCalled()
  })

  it('tolerates surrounding whitespace and a trailing PR path', () => {
    expect(parseLanePrsArgs(`  hide   ${URL}/files  `)).toEqual({ action: 'hide', ref: REF })
  })

  it('says so when this pi cannot persist an entry', async () => {
    const f = fixture(null)
    await expect(f.run(`pin ${URL}`)).rejects.toThrow(
      'This Pi version cannot persist lane pull requests.',
    )
  })
})

describe('parseLanePrUrl', () => {
  // The extension cannot import @phosphor/shared, so it keeps its own copy.
  it.each([
    URL,
    'https://GitHub.com/Acme/web/pull/57',
    'https://github.example.com/a-b/c.d_e/pull/123456789',
    'https://github.com/acme/web/pull/57/files',
    'https://github.com/acme/web/pull/57#discussion_r1',
    'https://github.com/acme/web/pull/0',
    'https://github.com/acme/../pull/5',
    'https://github.com/-acme/web/pull/5',
    'https://localhost/acme/web/pull/5',
    'http://github.com/acme/web/pull/5',
    'https://github.com/acme/web/pull/1234567890',
  ])('agrees with parsePrUrl on %s', (url) => {
    const ref = parseLanePrUrl(url)
    expect(ref).toEqual(parsePrUrl(url))
    if (ref) expect(isPrRef(ref)).toBe(true)
  })
})
