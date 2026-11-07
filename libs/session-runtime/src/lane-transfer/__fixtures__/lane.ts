import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectDirForCwd, sessionDirForCwd } from '../../pi/pi-paths'

export const SESSION_ID = '01a1b11c-7705-7534-964e-c100db3101ce'
export const CLI_ID = '11111111-2222-4333-8444-555555555555'
export const RUN_ID = 'c6103c13-c565-4254-a7ca-42fed5d53efa'

/** A machine of its own: a home whose pi and Claude folders live in a temp dir. */
export function machine(name: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `lane-${name}-`)))
  return { home, env: {} as NodeJS.ProcessEnv }
}

/**
 * A stopped lane the way pi, pi-subagents and pi-claude-cli leave one: the
 * transcript, a child run, this run's subagent artifacts (and another lane's),
 * the provider's pairing, CLI transcript, sidecar and stored prompt, and an
 * attached file.
 */
export function writeLane(paths: { home: string; env: NodeJS.ProcessEnv }, cwd: string) {
  const dir = sessionDirForCwd(cwd, join(paths.home, '.pi', 'agent', 'sessions'))
  mkdirSync(dir, { recursive: true })
  const fileName = `2026-11-06T13-46-35-141Z_${SESSION_ID}.jsonl`
  const sessionFile = join(dir, fileName)
  const attachment = join(paths.home, 'notes.txt')
  writeFileSync(attachment, 'attached bytes')
  const lines = [
    { type: 'session', version: 3, id: SESSION_ID, timestamp: 't', cwd, parentSession: '/x.jsonl' },
    { type: 'session_info', id: 'a1', parentId: null, name: 'Fix The Thing' },
    {
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `look\n\n<attached-files>\n${attachment}\n/gone.pdf\n</attached-files>`,
          },
        ],
      },
    },
    {
      type: 'message',
      id: 'a3',
      parentId: 'a2',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `see subagent-artifacts/outputs/report.md and artifact://${SESSION_ID}/report`,
          },
        ],
      },
    },
  ]
  writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const run = join(sessionFile.replace(/\.jsonl$/, ''), RUN_ID, 'run-0')
  mkdirSync(run, { recursive: true })
  writeFileSync(
    join(run, 'session.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: '01a1b11c-7705-7534-964e-c100db3101cf', cwd })}\n`,
  )
  const artifacts = join(dir, 'subagent-artifacts')
  mkdirSync(join(artifacts, 'outputs'), { recursive: true })
  writeFileSync(join(artifacts, `${RUN_ID}_reviewer_output.md`), 'mine')
  writeFileSync(join(artifacts, 'outputs', 'report.md'), 'referenced')
  writeFileSync(join(artifacts, '99999999-0000-4000-8000-000000000000_other_output.md'), 'not mine')
  const state = join(paths.home, '.pi', 'agent', 'pi-claude-cli')
  mkdirSync(join(state, 'sysprompt'), { recursive: true })
  writeFileSync(join(state, 'session-map.json'), JSON.stringify({ [SESSION_ID]: CLI_ID }))
  writeFileSync(join(state, 'sysprompt', `${CLI_ID}.txt`), 'prompt')
  const project = claudeProjectDirForCwd(cwd, paths.env, paths.home)
  mkdirSync(join(project, CLI_ID), { recursive: true })
  writeFileSync(join(project, `${CLI_ID}.jsonl`), `${JSON.stringify({ sessionId: CLI_ID, cwd })}\n`)
  writeFileSync(join(project, CLI_ID, 'tool-result.txt'), 'big result')
  return { sessionFile, fileName, attachment }
}
