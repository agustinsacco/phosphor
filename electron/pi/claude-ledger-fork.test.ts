import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { forkClaudeLedgerForClone } from './claude-ledger-fork'
import { claudeProjectDirForCwd } from './pi-paths'

const OLD_PI_ID = '01a07dbb-7dea-75b1-9d10-5abdf1499cf9'
const NEW_PI_ID = '01a07ecb-f990-7149-879a-dcc27b874128'
const OLD_CLI_ID = 'a48dc146-a367-4be7-bc92-b1d45c90c148'

/**
 * The scenario is the one measured on 2026-09-07: a sidebar clone gives pi a
 * new session id, and without a ledger fork the provider's next
 * turn reimports the whole conversation. These tests build both trees — pi's
 * session files and the CLI's project dir — in a sandbox via the same env
 * overrides the real programs honour.
 */
describe('forkClaudeLedgerForClone', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let oldPiFile: string
  let newPiFile: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phosphor-ledger-fork-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'state')
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
    await mkdir(cwd, { recursive: true })
    await mkdir(join(stateDir, 'sysprompt'), { recursive: true })
    await mkdir(claudeProjectDirForCwd(cwd), { recursive: true })

    oldPiFile = join(root, 'old.jsonl')
    newPiFile = join(root, 'new.jsonl')
    const message = JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user' } })
    await writeFile(
      oldPiFile,
      JSON.stringify({ type: 'session', version: 3, id: OLD_PI_ID, cwd }) + '\n' + message + '\n',
      'utf8',
    )
    await writeFile(
      newPiFile,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: NEW_PI_ID,
        cwd,
        parentSession: oldPiFile,
      }) +
        '\n' +
        message +
        '\n',
      'utf8',
    )
  })

  afterEach(async () => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    await rm(root, { recursive: true, force: true })
  })

  async function writeMap(map: Record<string, string>): Promise<void> {
    await writeFile(join(stateDir, 'session-map.json'), JSON.stringify(map), 'utf8')
  }

  async function readMap(): Promise<Record<string, string>> {
    return JSON.parse(await readFile(join(stateDir, 'session-map.json'), 'utf8')) as Record<
      string,
      string
    >
  }

  async function writeLedger(lines: string[]): Promise<string> {
    const path = join(claudeProjectDirForCwd(cwd), `${OLD_CLI_ID}.jsonl`)
    await writeFile(path, lines.join('\n') + '\n', 'utf8')
    return path
  }

  it('copies the ledger under a new CLI id and records the pairing', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID })
    await writeLedger([
      JSON.stringify({ type: 'user', sessionId: OLD_CLI_ID, message: { role: 'user' } }),
      JSON.stringify({ type: 'assistant', sessionId: OLD_CLI_ID, requestId: 'req_1' }),
    ])
    await writeFile(join(stateDir, 'sysprompt', `${OLD_CLI_ID}.txt`), 'the prompt', 'utf8')

    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(true)

    const map = await readMap()
    const newCliId = map[NEW_PI_ID]
    expect(newCliId).toBeTruthy()
    expect(newCliId).not.toBe(OLD_CLI_ID)
    // The original pairing survives: the pre-clone session is still resumable.
    expect(map[OLD_PI_ID]).toBe(OLD_CLI_ID)

    const forked = await readFile(join(claudeProjectDirForCwd(cwd), `${newCliId}.jsonl`), 'utf8')
    expect(forked).toContain(`"sessionId":"${newCliId}"`)
    expect(forked).not.toContain(OLD_CLI_ID)
    // Everything else survives byte-for-byte meaningful: same entry count.
    expect(forked.trim().split('\n')).toHaveLength(2)

    expect(await readFile(join(stateDir, 'sysprompt', `${newCliId}.txt`), 'utf8')).toBe(
      'the prompt',
    )
  })

  it('copies a line it cannot parse verbatim instead of dropping it', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID })
    await writeLedger([
      JSON.stringify({ type: 'user', sessionId: OLD_CLI_ID }),
      'not json at all {',
    ])

    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(true)
    const newCliId = (await readMap())[NEW_PI_ID]
    const forked = await readFile(join(claudeProjectDirForCwd(cwd), `${newCliId}.jsonl`), 'utf8')
    expect(forked).toContain('not json at all {')
  })

  it('does nothing when the parent has no CLI pairing (not a Claude session)', async () => {
    await writeMap({ 'some-other-session': 'whatever' })
    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(false)
    expect(await readdir(claudeProjectDirForCwd(cwd))).toEqual([])
  })

  it('respects a pairing the provider already made for the clone', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID, [NEW_PI_ID]: 'provider-made-this' })
    await writeLedger([JSON.stringify({ sessionId: OLD_CLI_ID })])

    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(false)
    expect((await readMap())[NEW_PI_ID]).toBe('provider-made-this')
  })

  it('does nothing when the parent ledger is already gone', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID })
    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(false)
    expect((await readMap())[NEW_PI_ID]).toBeUndefined()
  })

  it('does nothing for a session file with no parent (not a clone)', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID })
    await writeLedger([JSON.stringify({ sessionId: OLD_CLI_ID })])
    expect(await forkClaudeLedgerForClone(oldPiFile)).toBe(false)
  })

  it('works without a stored system prompt (pre-0.7 CLI session)', async () => {
    await writeMap({ [OLD_PI_ID]: OLD_CLI_ID })
    await writeLedger([JSON.stringify({ sessionId: OLD_CLI_ID })])
    expect(await forkClaudeLedgerForClone(newPiFile)).toBe(true)
    expect(await readdir(join(stateDir, 'sysprompt'))).toEqual([])
  })
})
