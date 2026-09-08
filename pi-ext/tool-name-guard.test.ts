import { describe, it, expect } from 'vitest'
import { isMalformedToolName, describeDroppedCall, sanitizeMessage } from './tool-name-guard'

describe('isMalformedToolName', () => {
  it('accepts ordinary tool names', () => {
    for (const name of ['read', 'fleet_status', 'artifact_create', 'Glob', 'a-b_c9']) {
      expect(isMalformedToolName(name)).toBe(false)
    }
  })

  it('accepts MCP-prefixed names, which are all underscores', () => {
    expect(isMalformedToolName('mcp__custom-tools__deploy')).toBe(false)
  })

  it('rejects the real-world failure: leaked tool-call syntax in the name', () => {
    // Observed from MiniMax M2 on Bedrock; bricked an orchestrator thread.
    expect(isMalformedToolName('mcp({})<tool_call>find')).toBe(true)
  })

  it('rejects names with characters no provider accepts', () => {
    for (const name of ['has space', 'dot.name', 'paren()', 'Claude Code · Read', 'a/b']) {
      expect(isMalformedToolName(name)).toBe(true)
    }
  })

  it('rejects empty, over-long and non-string names', () => {
    expect(isMalformedToolName('')).toBe(true)
    expect(isMalformedToolName('x'.repeat(129))).toBe(true)
    expect(isMalformedToolName(undefined)).toBe(true)
    expect(isMalformedToolName(42)).toBe(true)
  })
})

describe('sanitizeMessage', () => {
  const bad = {
    type: 'toolCall',
    name: 'mcp({})<tool_call>find',
    arguments: { pattern: '**/*mcp*.json' },
  }

  it('leaves a clean assistant message untouched', () => {
    expect(
      sanitizeMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'toolCall', name: 'find', arguments: {} },
        ],
      }),
    ).toBeNull()
  })

  it('replaces only the malformed call, keeping the good ones', () => {
    const result = sanitizeMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }, bad, { type: 'toolCall', name: 'ls' }],
    })
    expect(result).not.toBeNull()
    const content = result!.content
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'text', text: 'working' })
    // The malformed one became prose that still shows what was attempted.
    expect(content[1]!.type).toBe('text')
    expect(content[1]!.text).toContain('mcp({})<tool_call>find')
    expect(content[1]!.text).toContain('**/*mcp*.json')
    // The valid call survives untouched.
    expect(content[2]).toEqual({ type: 'toolCall', name: 'ls' })
  })

  it('ignores non-assistant messages and non-array content', () => {
    expect(sanitizeMessage({ role: 'user', content: [bad] })).toBeNull()
    expect(sanitizeMessage({ role: 'assistant', content: 'plain' })).toBeNull()
  })

  it('produces a name Bedrock would accept nowhere in the output', () => {
    const result = sanitizeMessage({ role: 'assistant', content: [bad] })!
    for (const block of result.content) {
      if (block.type === 'toolCall') {
        expect(isMalformedToolName(block.name)).toBe(false)
      }
    }
  })
})

describe('describeDroppedCall', () => {
  it('names the call and previews its arguments', () => {
    expect(describeDroppedCall('bad name', { a: 1 })).toBe(
      '[Phosphor dropped a malformed tool call: bad name {"a":1}]',
    )
  })

  it('omits empty arguments', () => {
    expect(describeDroppedCall('bad', {})).toBe('[Phosphor dropped a malformed tool call: bad]')
  })

  it('survives unserializable arguments', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => describeDroppedCall('bad', circular)).not.toThrow()
  })
})
