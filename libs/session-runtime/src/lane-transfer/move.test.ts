import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectDirForCwd, sessionDirForCwd } from '../pi/pi-paths'
import { openArchive } from './archive'
import { CLI_ID, RUN_ID, SESSION_ID, machine, writeLane } from './__fixtures__/lane'
import { installLane } from './install'
import { exportLane, inspectLane, prepareImport, sessionTaken } from './move'
import { LANE_MOVED_TYPE } from './notice'

const labels = { from: 'This Mac', to: 'bee1' }
const noWorktrees = { add: () => Promise.reject(new Error('no worktrees in a folder')) }

function lines(file: string) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function moveFolderLane(sameMachine: boolean) {
  const from = machine('from')
  const to = sameMachine ? from : machine('to')
  const sourceCwd = join(from.home, 'scratch')
  const targetRoot = join(to.home, 'elsewhere')
  mkdirSync(sourceCwd)
  mkdirSync(targetRoot)
  const lane = writeLane(from, sourceCwd)
  const source = {
    sessionFile: lane.sessionFile,
    workspace: 'scratch',
    paths: from,
    runtime: async () => ({ piVersion: '0.86.0', claudeVersion: '0.10.0', models: null }),
    attachmentAllowed: () => !sameMachine,
  }
  const archivePath = join(from.home, 'bundle')
  await exportLane(source, archivePath)
  const prepared = await prepareImport({
    archivePath,
    root: targetRoot,
    workspace: 'elsewhere',
    branchPrefix: 'phosphor/',
    sameMachine,
    worktrees: noWorktrees,
  })
  const installed = await installLane({
    archive: prepared.archive,
    plan: prepared.plan,
    cwd: prepared.folder.cwd,
    paths: to,
    labels,
    attachmentsDir: sameMachine ? null : () => join(to.home, 'attachments'),
    sessionTaken: sessionTaken(to),
  })
  return { from, to, lane, sourceCwd, targetRoot, installed, prepared }
}

describe('moving a lane in a folder git does not track', () => {
  it('carries the transcript, child runs, its own artifacts, Claude data and attachments', async () => {
    const { to, lane, targetRoot, installed, prepared } = await moveFolderLane(false)
    expect(prepared.plan).toMatchObject({ mode: 'folder', branch: null, blockers: [] })
    // Another machine has no such session, so the id and file name stay.
    expect(installed.sessionId).toBe(SESSION_ID)
    expect(installed.sessionFile).toBe(
      join(sessionDirForCwd(targetRoot, join(to.home, '.pi/agent/sessions')), lane.fileName),
    )
    const entries = lines(installed.sessionFile)
    expect(entries[0]).toMatchObject({ type: 'session', id: SESSION_ID, cwd: targetRoot })
    expect(entries[0]).not.toHaveProperty('parentSession')
    expect(entries.slice(1, 4)).toEqual(lines(lane.sessionFile).slice(1))
    const notice = entries[4]!
    expect(notice).toMatchObject({
      type: 'custom_message',
      customType: LANE_MOVED_TYPE,
      parentId: 'a3',
      display: true,
    })
    expect(notice.content).toContain('from This Mac (scratch,')
    expect(notice.content).toContain('Files from the old folder did not move.')
    expect(notice.content).toContain(
      `${lane.attachment} → ${join(to.home, 'attachments', '0', 'notes.txt')}`,
    )
    expect(readFileSync(join(to.home, 'attachments', '0', 'notes.txt'), 'utf8')).toBe(
      'attached bytes',
    )
    // The row keeps its age and order.
    // Filesystems may round `utimes` by a fraction of a millisecond.
    expect(
      Math.abs(statSync(installed.sessionFile).mtimeMs - statSync(lane.sessionFile).mtimeMs),
    ).toBeLessThan(2)

    const dir = sessionDirForCwd(targetRoot, join(to.home, '.pi/agent/sessions'))
    const child = lines(
      join(installed.sessionFile.replace(/\.jsonl$/, ''), RUN_ID, 'run-0', 'session.jsonl'),
    )
    expect(child[0]).toMatchObject({ cwd: targetRoot })
    expect(readdirSync(join(dir, 'subagent-artifacts')).sort()).toEqual([
      `${RUN_ID}_reviewer_output.md`,
      'outputs',
    ])

    const state = join(to.home, '.pi/agent/pi-claude-cli')
    expect(JSON.parse(readFileSync(join(state, 'session-map.json'), 'utf8'))).toEqual({
      [SESSION_ID]: CLI_ID,
    })
    expect(readFileSync(join(state, 'sysprompt', `${CLI_ID}.txt`), 'utf8')).toBe('prompt')
    const project = claudeProjectDirForCwd(targetRoot, to.env, to.home)
    expect(existsSync(join(project, `${CLI_ID}.jsonl`))).toBe(true)
    expect(readFileSync(join(project, CLI_ID, 'tool-result.txt'), 'utf8')).toBe('big result')
  })

  it('gives a copy on the same machine new ids and keeps the old attachment paths', async () => {
    const { from, targetRoot, installed } = await moveFolderLane(true)
    expect(installed.sessionId).not.toBe(SESSION_ID)
    expect(installed.sessionFile).toContain(installed.sessionId)
    const map = JSON.parse(
      readFileSync(join(from.home, '.pi/agent/pi-claude-cli/session-map.json'), 'utf8'),
    ) as Record<string, string>
    const cli = map[installed.sessionId]!
    expect(cli).toBeTruthy()
    expect(cli).not.toBe(CLI_ID)
    expect(map[SESSION_ID]).toBe(CLI_ID)
    const copied = lines(
      join(claudeProjectDirForCwd(targetRoot, from.env, from.home), `${cli}.jsonl`),
    )
    expect(copied[0]).toMatchObject({ sessionId: cli })
    const notice = lines(installed.sessionFile).at(-1)!
    expect(notice.content).not.toContain('Attached files')
  })

  it('rekeys its own artifact links when the session id collides', async () => {
    const { installed } = await moveFolderLane(true)
    const text = readFileSync(installed.sessionFile, 'utf8')
    expect(text).toContain(`artifact://${installed.sessionId}/report`)
    expect(text).not.toContain(`artifact://${SESSION_ID}/report`)
  })

  it('rediscovers the relocated attachment when a moved lane moves again', async () => {
    const { to, installed, targetRoot } = await moveFolderLane(false)
    const archivePath = join(to.home, 'second.bundle')
    await exportLane(
      {
        sessionFile: installed.sessionFile,
        workspace: 'elsewhere',
        paths: to,
        attachmentAllowed: (path) => path.startsWith(join(to.home, 'attachments') + '/'),
      },
      archivePath,
    )
    const archive = await openArchive(archivePath)
    const attachments = archive.manifest.parts.filter((p) => p.kind === 'attachment')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.from).toBe(join(to.home, 'attachments', '0', 'notes.txt'))
    expect(archive.manifest.source.cwd).toBe(targetRoot)
  })

  it('skips an attachment changed after a prior move instead of exporting different bytes', async () => {
    const { to, installed } = await moveFolderLane(false)
    writeFileSync(join(to.home, 'attachments', '0', 'notes.txt'), 'changed since the move')
    const archivePath = join(to.home, 'changed.bundle')
    await exportLane(
      {
        sessionFile: installed.sessionFile,
        workspace: 'elsewhere',
        paths: to,
        attachmentAllowed: () => true,
      },
      archivePath,
    )
    const archive = await openArchive(archivePath)
    expect(archive.manifest.parts.filter((p) => p.kind === 'attachment')).toEqual([])
  })

  it('skips a file modified after the user attached it', async () => {
    const from = machine('changed-original')
    const cwd = join(from.home, 'notes')
    mkdirSync(cwd)
    const lane = writeLane(from, cwd)
    const entries = lines(lane.sessionFile)
    entries[2]!.timestamp = '2000-01-01T00:00:00Z'
    writeFileSync(lane.sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const archivePath = join(from.home, 'bundle')
    await exportLane(
      {
        sessionFile: lane.sessionFile,
        workspace: 'notes',
        paths: from,
        attachmentAllowed: () => true,
      },
      archivePath,
    )
    expect(
      (await openArchive(archivePath)).manifest.parts.filter((p) => p.kind === 'attachment'),
    ).toEqual([])
  })

  it('writes nothing when part of the lane already exists there', async () => {
    const from = machine('undo-from')
    const to = machine('undo-to')
    const cwd = join(from.home, 'scratch')
    const root = join(to.home, 'target')
    mkdirSync(cwd)
    mkdirSync(root)
    const lane = writeLane(from, cwd)
    const archivePath = join(from.home, 'bundle')
    await exportLane(
      { sessionFile: lane.sessionFile, workspace: 's', paths: from, attachmentAllowed: () => true },
      archivePath,
    )
    const archive = await openArchive(archivePath)
    const dir = sessionDirForCwd(root, join(to.home, '.pi/agent/sessions'))
    // A transcript of the same name appears before the install publishes its own.
    mkdirSync(dir, { recursive: true })
    const plan = { mode: 'folder' as const, branch: null, workspace: 't', blockers: [] }
    const failing = installLane({
      archive,
      plan,
      cwd: root,
      paths: to,
      labels,
      attachmentsDir: () => join(to.home, 'attachments'),
      sessionTaken: async () => {
        writeFileSync(join(dir, lane.fileName), 'someone else')
        return false
      },
    })
    await expect(failing).rejects.toThrow('already exists')
    expect(readFileSync(join(dir, lane.fileName), 'utf8')).toBe('someone else')
    expect(existsSync(join(to.home, 'attachments'))).toBe(false)
    expect(existsSync(join(to.home, '.pi/agent/pi-claude-cli/session-map.json'))).toBe(false)
  })

  it('counts the move notice toward the destination transcript ceiling and rolls back', async () => {
    const from = machine('cap-from')
    const to = machine('cap-to')
    const cwd = join(from.home, 'notes')
    const target = join(to.home, 'notes')
    mkdirSync(cwd)
    mkdirSync(target)
    const lane = writeLane(from, cwd)
    const bundle = join(from.home, 'bundle')
    await exportLane(
      {
        sessionFile: lane.sessionFile,
        workspace: 'notes',
        paths: from,
        attachmentAllowed: () => false,
      },
      bundle,
    )
    const archive = await openArchive(bundle)
    await expect(
      installLane({
        archive,
        plan: { mode: 'folder', branch: null, workspace: 'notes', blockers: [] },
        cwd: target,
        paths: to,
        labels,
        attachmentsDir: null,
        sessionTaken: async () => false,
        maxTranscriptBytes: archive.manifest.source.transcriptBytes,
      }),
    ).rejects.toThrow('including its notice')
    expect(existsSync(sessionDirForCwd(target, join(to.home, '.pi/agent/sessions')))).toBe(false)
  })

  it('never follows a symlink in a destination ancestor', async () => {
    const from = machine('symlink-from')
    const to = machine('symlink-to')
    const cwd = join(from.home, 'notes')
    const target = join(to.home, 'notes')
    mkdirSync(cwd)
    mkdirSync(target)
    const lane = writeLane(from, cwd)
    const bundle = join(from.home, 'bundle')
    await exportLane(
      {
        sessionFile: lane.sessionFile,
        workspace: 'notes',
        paths: from,
        attachmentAllowed: () => false,
      },
      bundle,
    )
    const outside = join(to.home, 'outside')
    mkdirSync(outside)
    mkdirSync(join(to.home, '.pi', 'agent'), { recursive: true })
    symlinkSync(outside, join(to.home, '.pi', 'agent', 'sessions'))
    await expect(
      installLane({
        archive: await openArchive(bundle),
        plan: { mode: 'folder', branch: null, workspace: 'notes', blockers: [] },
        cwd: target,
        paths: to,
        labels,
        attachmentsDir: null,
        sessionTaken: async () => false,
      }),
    ).rejects.toThrow('symlink')
    expect(readdirSync(outside)).toEqual([])
  })

  it('reports why a lane cannot leave instead of throwing', async () => {
    const from = machine('blocked')
    expect(
      await inspectLane({
        sessionFile: join(from.home, 'missing.jsonl'),
        workspace: 'x',
        paths: from,
        attachmentAllowed: () => true,
      }),
    ).toEqual({ blockers: ['This lane has no saved transcript to move.'] })
  })

  it('refuses a bundle whose bytes were changed in transit', async () => {
    const from = machine('damaged')
    const cwd = join(from.home, 'scratch')
    mkdirSync(cwd)
    const lane = writeLane(from, cwd)
    const archivePath = join(from.home, 'bundle')
    await exportLane(
      { sessionFile: lane.sessionFile, workspace: 's', paths: from, attachmentAllowed: () => true },
      archivePath,
    )
    const bytes = readFileSync(archivePath)
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1)
    writeFileSync(archivePath, bytes)
    await expect(openArchive(archivePath)).rejects.toThrow('The lane bundle is damaged.')
  })
})
