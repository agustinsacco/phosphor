import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'subagent-save-'))
  writeFileSync(join(directory, 'parent.jsonl'), '')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
import artifactsExtension, { artifactsBeforeCompaction } from './artifacts'
import { ARTIFACT_ENTRY_TYPE } from './artifact-store'
import { SNAPSHOT_COMMAND, snapshotContent, type InspectionSnapshot } from './subagent-snapshot'

const snapshot: InspectionSnapshot = {
  sourceSessionId: 'native',
  runId: 'run',
  childId: 'child',
  readAt: '2026-10-11T10:00:00Z',
  inspection: {
    status: 'complete',
    task: 'Check the parser',
    messages: [{ role: 'assistant', text: 'Evidence ```\nnot a closing fence' }],
    finalOutput: 'CHANGES_REQUESTED',
    truncated: true,
  },
}
type Api = Parameters<typeof artifactsExtension>[0]
type Command = Parameters<NonNullable<Api['registerCommand']>>[1]
function harness(branch: unknown[] = []) {
  const commands = new Map<string, Command>()
  const hooks = new Map<string, Parameters<Api['on']>[1]>()
  const tools = new Map<
    string,
    { execute(id: string, args: Record<string, unknown>): Promise<{ content: { text: string }[] }> }
  >()
  const widgets: (string[] | undefined)[] = []
  const ctx = {
    sessionManager: {
      getSessionId: () => 'native',
      getSessionFile: () => join(directory, 'parent.jsonl'),
      getBranch: () => branch,
    },
    ui: { setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines) },
  }
  artifactsExtension({
    registerTool: (tool) =>
      tools.set(String(tool.name), tool as unknown as ReturnType<typeof tools.get> & {}),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, hook) => hooks.set(name, hook),
    appendEntry: (customType, data) =>
      branch.push({ type: 'custom', id: 'saved', parentId: null, customType, data }),
  })
  hooks.get('session_start')!({}, ctx)
  return { commands, hooks, tools, widgets, branch, ctx }
}
it('saves only through Pi, emits/retracts a receipt, and reconstructs after restart/compaction', async () => {
  const h = harness()
  await h.commands
    .get(SNAPSHOT_COMMAND)!
    .handler(`request ${encodeURIComponent(JSON.stringify(snapshot))}`, h.ctx)
  expect(h.branch).toHaveLength(1)
  expect(h.branch[0]).toMatchObject({ type: 'custom', customType: ARTIFACT_ENTRY_TYPE })
  expect(h.widgets).toHaveLength(2)
  expect(h.widgets[1]).toBeUndefined()
  const a = JSON.parse(h.widgets[0]![0]!.split('PHOSPHOR_SUBAGENT_SAVE:')[1]!).artifact
  expect(a.content).toContain('CHANGES_REQUESTED')
  expect(a.content).toContain('content was omitted')
  expect(a.content).toContain('not current status')
  expect(a.content).toContain('````text')
  const compacted = [
    ...h.branch,
    { type: 'compaction', id: 'compact', firstKeptEntryId: 'compact' },
  ]
  const resumed = harness(compacted)
  expect(
    (await resumed.tools.get('artifact_read')!.execute('read', { id: a.id })).content[0]!.text,
  ).toContain(a.content)
  expect(artifactsBeforeCompaction(compacted).map((r) => r.id)).toEqual([a.id])
  resumed.branch.splice(0)
  resumed.hooks.get('session_tree')!({}, resumed.ctx)
  await expect(resumed.tools.get('artifact_read')!.execute('read', { id: a.id })).rejects.toThrow(
    'No artifact',
  )
})
it.each([
  null,
  { ...snapshot, sourceSessionId: 'foreign' },
  { ...snapshot, runId: '--bad' },
  { ...snapshot, readAt: 'never' },
  { ...snapshot, inspection: { ...snapshot.inspection, finalOutput: 'x'.repeat(100_001) } },
])('refuses an invalid/foreign/oversized snapshot without appending %j', async (value) => {
  const h = harness()
  await h.commands
    .get(SNAPSHOT_COMMAND)!
    .handler(`request ${encodeURIComponent(JSON.stringify(value))}`, h.ctx)
  expect(h.branch).toHaveLength(0)
  expect(h.widgets[0]![0]).toContain('error')
})
it('refuses an in-memory-only session rather than claiming the copy is durable', async () => {
  const h = harness()
  rmSync(join(directory, 'parent.jsonl'))
  await h.commands
    .get(SNAPSHOT_COMMAND)!
    .handler(`request ${encodeURIComponent(JSON.stringify(snapshot))}`, h.ctx)
  expect(h.branch).toHaveLength(0)
  expect(h.widgets[0]![0]).toContain('not persisted yet')
})
it('bounds formatting overhead as well as the incoming payload', () => {
  expect(() =>
    snapshotContent(
      { ...snapshot, inspection: { ...snapshot.inspection, finalOutput: '`'.repeat(35000) } },
      'native',
    ),
  ).toThrow('too large')
})
it('captures content verbatim and never invents missing counters or an outcome', () => {
  const content = snapshotContent(
    { ...snapshot, inspection: { messages: [], truncated: false } },
    'native',
  )
  expect(content).toContain('Reported run state: unavailable')
  expect(content).not.toMatch(/tokens|accepted|0 tools/)
})
