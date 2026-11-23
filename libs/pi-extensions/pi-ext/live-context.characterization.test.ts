import { expect, it } from 'vitest'
import { parseProjectContext, renderProjectContext } from './context-files'
import { renderContextBlock } from './live-context'

// pi 1.5.2, core/system-prompt.js: buildSystemPromptSections with two contextFiles.
const section = `<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/fixture/global/AGENTS.md">
First\nline two
</project_instructions>

<project_instructions path="/fixture/project/CLAUDE.md">
Second\n
</project_instructions>
</project_context>`

it('round-trips the pi 1.5.2 project_context header, delimiters and file newlines', () => {
  const files = [
    { path: '/fixture/global/AGENTS.md', content: 'First\nline two' },
    { path: '/fixture/project/CLAUDE.md', content: 'Second\n' },
  ]
  expect(renderProjectContext(files.map(renderContextBlock))).toBe(section)
  expect(parseProjectContext(section)).toEqual(
    files.map((file) => ({ path: file.path, text: renderContextBlock(file) })),
  )
})
