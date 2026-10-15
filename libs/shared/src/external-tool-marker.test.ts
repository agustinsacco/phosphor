import { expect, it } from 'vitest'
import { isExternalToolMarker } from './external-tool-marker'
it.each([
  ['[Claude Code · Bash {"command":"ls"}]', true],
  ['[Claude Code · result #one {}]', true],
  ['[Claude ordinary text', false],
  ['', false],
])('recognises only marker blocks: %s', (text, expected) =>
  expect(isExternalToolMarker(text)).toBe(expected),
)
