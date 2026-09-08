import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listSessions,
  parseSessionFile,
  readSessionTree,
  sessionDirNameForCwd,
  workspaceStats,
} from './session-scanner'
import { appendBranchJump, appendLabel, forkSessionAt } from './session-writer'
import { readFile } from 'node:fs/promises'

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-uuid-1',
  timestamp: '2026-08-01T10:00:00.000Z',
  cwd: '/work/proj',
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

const SESSION_CONTENT =
  line(HEADER) +
  line({
    type: 'message',
    id: 'aaaa0001',
    parentId: null,
    timestamp: '2026-08-01T10:00:01.000Z',
    message: { role: 'user', content: 'build the thing', timestamp: 1 },
  }) +
  line({
    type: 'message',
    id: 'aaaa0002',
    parentId: 'aaaa0001',
    timestamp: '2026-08-01T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Building.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'make' } },
      ],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
      },
      stopReason: 'toolUse',
    },
  }) +
  line({
    type: 'session_info',
    id: 'aaaa0003',
    parentId: 'aaaa0002',
    timestamp: '2026-08-01T10:00:06.000Z',
    name: 'The Build Session',
  })

describe('session scanner', () => {
  let dir: string
  let sessionPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-scan-'))
    sessionPath = join(dir, '2026-08-01T10-00-00-000Z_sess-uuid-1.jsonl')
    await writeFile(sessionPath, SESSION_CONTENT, 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('mangles cwd into the session dir name like pi does', () => {
    expect(sessionDirNameForCwd('/Users/agustinsacco/src/GoAugment/knowledge')).toBe(
      '--Users-agustinsacco-src-GoAugment-knowledge--',
    )
    expect(sessionDirNameForCwd('/Users/agustinsacco')).toBe('--Users-agustinsacco--')
  })

  it('parses header, name, first message, counts and tokens in one pass', async () => {
    const meta = await parseSessionFile(sessionPath, 123)
    expect(meta).toMatchObject({
      sessionId: 'sess-uuid-1',
      cwd: '/work/proj',
      name: 'The Build Session',
      firstUserText: 'build the thing',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      totalTokens: 165,
    })
    expect(meta!.cost).toBeCloseTo(0.02)
  })

  it('reads the tree with previews and leaf', async () => {
    const tree = await readSessionTree(sessionPath)
    expect(tree.sessionId).toBe('sess-uuid-1')
    expect(tree.leafId).toBe('aaaa0003')
    const user = tree.entries.find((e) => e.id === 'aaaa0001')!
    expect(user.role).toBe('user')
    expect(user.preview).toBe('build the thing')
    const assistant = tree.entries.find((e) => e.id === 'aaaa0002')!
    expect(assistant.toolName).toBe('bash')
  })

  it('appends labels and branch jumps in the documented format', async () => {
    await appendLabel(sessionPath, 'aaaa0001', 'checkpoint')
    await appendBranchJump(sessionPath, 'aaaa0001')
    const raw = await readFile(sessionPath, 'utf8')
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const label = lines.find((l) => l.type === 'label')!
    expect(label.targetId).toBe('aaaa0001')
    expect(label.label).toBe('checkpoint')
    const jump = lines.at(-1)!
    expect(jump.type).toBe('branch_summary')
    expect(jump.parentId).toBe('aaaa0001')
    // Tree leaf resolution should now land on the jump entry.
    const tree = await readSessionTree(sessionPath)
    expect(tree.leafId).toBe(jump.id)
  })

  it('forkSessionAt copies the file with a new identity and jumps the leaf', async () => {
    const newPath = await forkSessionAt(sessionPath, 'aaaa0001')
    const raw = await readFile(newPath, 'utf8')
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const header = lines[0]!
    expect(header.type).toBe('session')
    expect(header.id).not.toBe('sess-uuid-1')
    expect(header.parentSession).toBe(sessionPath)
    const jump = lines.at(-1)!
    expect(jump.type).toBe('branch_summary')
    expect(jump.parentId).toBe('aaaa0001')
  })

  it('orders sessions by immutable creation time, not changed-file mtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phosphor-scan-order-'))
    const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    try {
      const workspace = '/work/ordered'
      const workspaceDir = join(root, sessionDirNameForCwd(workspace))
      await mkdir(workspaceDir, { recursive: true })
      const older = join(workspaceDir, 'older.jsonl')
      const newer = join(workspaceDir, 'newer.jsonl')
      await writeFile(older, SESSION_CONTENT, 'utf8')
      await writeFile(
        newer,
        SESSION_CONTENT.replace('sess-uuid-1', 'sess-uuid-2').replace(
          '2026-08-01T10:00:00.000Z',
          '2026-08-02T10:00:00.000Z',
        ),
        'utf8',
      )
      // Activity on the older session touches its JSONL file, but must not
      // move it above the newer session in the sidebar.
      await utimes(
        older,
        new Date('2026-08-03T00:00:00.000Z'),
        new Date('2026-08-03T00:00:00.000Z'),
      )
      await utimes(
        newer,
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
      )

      expect((await listSessions(workspace)).map((session) => session.sessionId)).toEqual([
        'sess-uuid-2',
        'sess-uuid-1',
      ])
    } finally {
      if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists and aggregates workspace stats through the mangled dir', async () => {
    // listSessions uses the real pi root; simulate by pointing env at our tmp.
    const prevEnv = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = dir
    try {
      const wsDir = join(dir, sessionDirNameForCwd('/work/proj'))
      await mkdir(wsDir, { recursive: true })
      await writeFile(join(wsDir, '2026-08-01T10-00-00-000Z_x.jsonl'), SESSION_CONTENT, 'utf8')
      const sessions = await listSessions('/work/proj')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.name).toBe('The Build Session')

      const stats = await workspaceStats('/work/proj')
      expect(stats.sessionCount).toBe(1)
      expect(stats.messages).toBe(2)
      expect(stats.tokens).toBe(165)
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = prevEnv
    }
  })
})
