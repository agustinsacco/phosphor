import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import globalContext from './global-context'
import { filterSystemMessages, renderProjectContext } from './context-files'
import { renderContextBlock } from './live-context'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-live-context-'))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

it.each(['AGENTS.md', 'CLAUDE.md'])(
  'refreshes rendered %s before filtering and measures the new text',
  (name) => {
    const agent = join(dir, 'agent'),
      repo = join(dir, 'repo')
    mkdirSync(agent)
    mkdirSync(repo)
    const path = join(repo, name)
    const section = (content: string) =>
      renderProjectContext([renderContextBlock({ path, content })])
    writeFileSync(path, 'old')
    const started = section('old')
    let hook!: (event: unknown, ctx: unknown) => unknown
    const live = globalContext(
      {
        on: (_key, h) => {
          hook = h
        },
      },
      agent,
      [],
    )
    const send = () => {
      const messages = [{ role: 'system', sections: { project_context: started } }]
      hook({ messages }, { cwd: repo })
      return messages
    }
    expect(send()[0]!.sections.project_context).toBe(started)
    writeFileSync(path, '\ufeffnew content')
    writeFileSync(join(repo, 'AGENTS.override.md'), 'undiscovered')
    const updated = send()
    expect(updated[0]!.sections.project_context).toBe(section('new content'))
    expect(live.prompt(started, repo)).toBe(section('new content'))
    filterSystemMessages(updated, new Set(['agents', 'claude']), agent)
    expect(updated[0]!.sections).toEqual({})
    unlinkSync(path)
    expect(send()[0]!.sections).toEqual({})
    symlinkSync(join(repo, 'AGENTS.override.md'), path)
    expect(send()[0]!.sections.project_context).toBe(started)
  },
)
