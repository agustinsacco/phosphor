export const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-uuid-1',
  timestamp: '2026-08-01T10:00:00.000Z',
  cwd: '/work/proj',
}

export function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

/** One turn's worth of entries: a user message, then an assistant reply. */
export function turn(index: number, parent: string | null, text = 'ok'): string {
  const userId = `u${String(index).padStart(4, '0')}`
  const assistantId = `a${String(index).padStart(4, '0')}`
  return (
    line({
      type: 'message',
      id: userId,
      parentId: parent,
      timestamp: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      message: { role: 'user', content: `${text} ${index}`, timestamp: index },
    }) +
    line({
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:30.000Z`,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `reply ${index} — “curly” ✅ 日本語` },
          { type: 'toolCall', id: `c${index}`, name: 'bash', arguments: { command: 'make' } },
        ],
        usage: {
          input: 10 + index,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.001 * (index + 1) },
        },
        timestamp: index,
      },
    })
  )
}
