import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectDirName } from './pi-paths'

/**
 * Deleting a Claude Code session used to leave the CLI's copy of the
 * transcript behind — two real sessions orphaned 22 MB between them. These
 * cover the three outcomes that matter: the copy is found and trashed, its
 * absence is silent, and a session from another provider is left untouched.
 *
 * `shell.trashItem` is mocked, so what is asserted is which paths we ASK to
 * trash — and that nothing here ever unlinks.
 */

const trashed: string[] = []
const trashItem = vi.fn()

vi.mock('electron', () => ({ shell: { trashItem: (path: string) => trashItem(path) } }))

const { deleteSession } = await import('./session-deleter')

const SESSION_ID = '01a0272a-7be5-76ed-b420-36b363924622'
/** What the provider's sidecar maps that pi session to under observer mode. */
const CLI_SESSION_ID = 'dea87c8e-4de1-4f0e-9d5b-9a3c2f10c0b7'

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

/** A transcript shaped like pi's: header, model_change, then messages. */
function transcript(cwd: string, provider: string): string {
  return (
    line({
      type: 'session',
      version: 3,
      id: SESSION_ID,
      timestamp: '2026-08-22T22:56:30.785Z',
      cwd,
    }) +
    line({
      type: 'model_change',
      id: 'aaaa0001',
      parentId: null,
      timestamp: '2026-08-22T22:56:31.563Z',
      provider,
      modelId: 'claude-opus-5',
    }) +
    line({
      type: 'message',
      id: 'aaaa0002',
      parentId: 'aaaa0001',
      timestamp: '2026-08-22T22:56:31.573Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }) +
    line({
      type: 'message',
      id: 'aaaa0003',
      parentId: 'aaaa0002',
      timestamp: '2026-08-22T22:56:37.006Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], provider },
    })
  )
}

describe('deleteSession', () => {
  let root: string
  let piPath: string
  let workspace: string
  let claudeDir: string
  let claudeLedger: string

  beforeEach(async () => {
    trashed.length = 0
    trashItem.mockReset()
    trashItem.mockImplementation(async (path: string) => {
      trashed.push(path)
    })

    root = await mkdtemp(join(tmpdir(), 'phosphor-delete-'))
    // The workspace has to exist on disk: the path helper resolves symlinks
    // before mangling, exactly as both harnesses do.
    workspace = join(root, 'proj')
    await mkdir(workspace)
    piPath = join(root, `2026-08-22T22-56-30-785Z_${SESSION_ID}.jsonl`)

    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
    // The provider's sidecar lives here; an empty state dir means "no
    // mapping", which is the pre-observer-mode shape.
    process.env.PI_CLAUDE_CLI_STATE_DIR = join(root, 'cli-state')
    claudeDir = join(
      process.env.CLAUDE_CONFIG_DIR,
      'projects',
      claudeProjectDirName(realpathSync.native(workspace)),
    )
    claudeLedger = join(claudeDir, `${SESSION_ID}.jsonl`)
  })

  afterEach(async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.PI_CLAUDE_CLI_STATE_DIR
    await rm(root, { recursive: true, force: true })
  })

  /** Pair the pi session with a CLI session, the way the provider does. */
  async function writeSessionMap(cliSessionId: string): Promise<void> {
    const dir = process.env.PI_CLAUDE_CLI_STATE_DIR!
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'session-map.json'),
      JSON.stringify({ [SESSION_ID]: cliSessionId }),
      'utf8',
    )
  }

  async function writeClaudeLedger(): Promise<void> {
    await mkdir(claudeDir, { recursive: true })
    await writeFile(claudeLedger, line({ type: 'summary', summary: 'the CLI copy' }), 'utf8')
  }

  it('trashes the CLI copy alongside pi’s transcript', async () => {
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    await writeClaudeLedger()

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath, claudeLedger])
  })

  it('trashes the copy filed under the CLI’s OWN session id', async () => {
    // Observer mode: the CLI gets a session id of its own, and the transcript
    // is filed under THAT. Deleting by the pi id trashed nothing at all and
    // orphaned the copy — which is megabytes, every time.
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    await writeSessionMap(CLI_SESSION_ID)
    const mappedLedger = join(claudeDir, `${CLI_SESSION_ID}.jsonl`)
    await mkdir(claudeDir, { recursive: true })
    await writeFile(mappedLedger, line({ type: 'summary', summary: 'the CLI copy' }), 'utf8')
    // The path derived from the pi id exists too, and must be left alone: it
    // belongs to no session this delete is responsible for.
    await writeClaudeLedger()

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath, mappedLedger])
  })

  it('trashes only pi’s transcript when no CLI copy exists', async () => {
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')

    await deleteSession(piPath)

    // The normal case for older sessions — silent, and the delete still works.
    expect(trashed).toEqual([piPath])
  })

  it('never touches the CLI tree for a non-Claude provider', async () => {
    await writeFile(piPath, transcript(workspace, 'anthropic'), 'utf8')
    // Even with a same-named file sitting in the CLI's tree, a session that
    // did not run on that provider must not have it deleted out from under it.
    await writeClaudeLedger()

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath])
  })

  it('finds a provider switched to mid-session', async () => {
    // model_change is not confined to the top of the file, so recognising a
    // Claude session means scanning rather than peeking at the header.
    await writeFile(
      piPath,
      transcript(workspace, 'anthropic') +
        line({
          type: 'model_change',
          id: 'aaaa0004',
          parentId: 'aaaa0003',
          timestamp: '2026-08-22T23:10:00.000Z',
          provider: 'pi-claude-cli',
          modelId: 'claude-opus-5',
        }),
      'utf8',
    )
    await writeClaudeLedger()

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath, claudeLedger])
  })

  it('succeeds when an orphan transcript is already missing', async () => {
    await expect(deleteSession(piPath)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('reports a real trash failure instead of claiming success', async () => {
    await writeFile(piPath, transcript(workspace, 'anthropic'), 'utf8')
    trashItem.mockRejectedValue(new Error('Trash unavailable'))
    await expect(deleteSession(piPath)).rejects.toThrow('Trash unavailable')
  })

  it('still deletes pi’s transcript when it is malformed', async () => {
    await writeFile(piPath, 'not json at all\n', 'utf8')

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath])
  })

  it('trashes the CLI session’s sidecar directory too', async () => {
    // Subagent transcripts and oversized tool results live in `<cliId>/`
    // beside the jsonl, and outlived every delete — even ones whose jsonl was
    // already gone.
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    await writeSessionMap(CLI_SESSION_ID)
    const sidecar = join(claudeDir, CLI_SESSION_ID)
    await mkdir(join(sidecar, 'subagents'), { recursive: true })

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath, sidecar])
  })

  it('forgets the provider’s pairing and stored prompt', async () => {
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    const state = process.env.PI_CLAUDE_CLI_STATE_DIR!
    await mkdir(join(state, 'sysprompt'), { recursive: true })
    const other = { '01a0ffff-0000-7000-8000-000000000000': 'other-cli-id' }
    await writeFile(
      join(state, 'session-map.json'),
      JSON.stringify({ ...other, [SESSION_ID]: CLI_SESSION_ID }),
      'utf8',
    )
    const prompt = join(state, 'sysprompt', `${CLI_SESSION_ID}.txt`)
    await writeFile(prompt, 'context=pi', 'utf8')

    await deleteSession(piPath)

    // Every other session's pairing survives the rewrite.
    expect(JSON.parse(await readFile(join(state, 'session-map.json'), 'utf8'))).toEqual(other)
    await expect(access(prompt)).rejects.toThrow()
  })

  it('leaves a CLI transcript another pi session still resumes', async () => {
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    const state = process.env.PI_CLAUDE_CLI_STATE_DIR!
    await mkdir(state, { recursive: true })
    await writeFile(
      join(state, 'session-map.json'),
      JSON.stringify({ [SESSION_ID]: CLI_SESSION_ID, other: CLI_SESSION_ID }),
      'utf8',
    )
    const mappedLedger = join(claudeDir, `${CLI_SESSION_ID}.jsonl`)
    await mkdir(claudeDir, { recursive: true })
    await writeFile(mappedLedger, line({ type: 'summary', summary: 'shared' }), 'utf8')

    await deleteSession(piPath)

    expect(trashed).toEqual([piPath])
  })

  it('removes pi’s session directory once it is empty, and only then', async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'sessions')
    try {
      const dir = join(root, 'sessions', '--proj--')
      await mkdir(dir, { recursive: true })
      const first = join(dir, `a_${SESSION_ID}.jsonl`)
      const second = join(dir, 'b_other.jsonl')
      await writeFile(first, transcript(workspace, 'anthropic'), 'utf8')
      await writeFile(second, transcript(workspace, 'anthropic'), 'utf8')
      // The mocked trash only records; unlink so the directory really empties.
      trashItem.mockImplementation(async (path: string) => {
        trashed.push(path)
        await rm(path, { recursive: true, force: true })
      })

      await deleteSession(first)
      await expect(access(dir)).resolves.toBeUndefined()

      await deleteSession(second)
      await expect(access(dir)).rejects.toThrow()
      // The sessions root itself is never a candidate.
      await expect(access(join(root, 'sessions'))).resolves.toBeUndefined()
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR
    }
  })

  it('never removes the folder of a transcript outside pi’s sessions root', async () => {
    const dir = join(root, 'elsewhere')
    await mkdir(dir)
    const file = join(dir, `x_${SESSION_ID}.jsonl`)
    await writeFile(file, transcript(workspace, 'anthropic'), 'utf8')
    trashItem.mockImplementation(async (path: string) => {
      await rm(path, { force: true })
    })

    await deleteSession(file)

    await expect(access(dir)).resolves.toBeUndefined()
  })

  it('does not fail the delete when trashing the CLI copy throws', async () => {
    await writeFile(piPath, transcript(workspace, 'pi-claude-cli'), 'utf8')
    await writeClaudeLedger()
    trashItem.mockImplementation(async (path: string) => {
      trashed.push(path)
      if (path === claudeLedger) throw new Error('trash unavailable')
    })

    await expect(deleteSession(piPath)).resolves.toBeUndefined()
    expect(trashed).toEqual([piPath, claudeLedger])
  })
})
