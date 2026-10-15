export const EXTERNAL_TOOL_MARKER = /^\[Claude Code · ([^\s\]]+)(?:\s+([\s\S]*))?\]$/

export function isExternalToolMarker(text: string): boolean {
  return EXTERNAL_TOOL_MARKER.test(text.trim())
}
