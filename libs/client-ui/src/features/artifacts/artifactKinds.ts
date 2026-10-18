import type { Artifact } from '@/stores/artifacts'

/**
 * Per-type presentation metadata for artifacts.
 *
 * This replaces four parallel type-switch ladders (preview glyph, Monaco
 * language, download extension, and the preview renderer) that each had their
 * own fallback and had to be kept in sync by hand — adding an artifact type
 * meant remembering all four.
 */
interface ArtifactKind {
  /** Gallery glyph. */
  glyph: string
  /** Monaco / CodeBlock language id for the source view. */
  language: string
  /** Download file extension. */
  extension: string
}

const KINDS: Record<Exclude<Artifact['type'], 'code'>, ArtifactKind> = {
  html: { glyph: '🌐', language: 'html', extension: 'html' },
  svg: { glyph: '🎨', language: 'xml', extension: 'svg' },
  mermaid: { glyph: '📊', language: 'mermaid', extension: 'mmd' },
  chart: { glyph: '📈', language: 'json', extension: 'json' },
  markdown: { glyph: '📄', language: 'markdown', extension: 'md' },
}

/** `code` artifacts carry their own language, so they resolve dynamically. */
const CODE_GLYPH = '⌨️'

export function artifactGlyph(type: Artifact['type']): string {
  return type === 'code' ? CODE_GLYPH : (KINDS[type]?.glyph ?? CODE_GLYPH)
}

export function artifactLanguage(artifact: Artifact): string {
  if (artifact.type === 'code') return artifact.language ?? 'text'
  return KINDS[artifact.type]?.language ?? 'text'
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  go: 'go',
  java: 'java',
  ruby: 'rb',
  shell: 'sh',
  bash: 'sh',
  css: 'css',
  json: 'json',
  yaml: 'yml',
}

function extensionForLanguage(language?: string): string {
  return LANGUAGE_EXTENSIONS[language?.toLowerCase() ?? ''] ?? 'txt'
}

/** Download filename: sanitized artifact id plus a type-appropriate extension. */
export function suggestedFileName(artifact: Artifact): string {
  const base = artifact.id.replace(/[^a-z0-9-]/gi, '-')
  const extension =
    artifact.type === 'code'
      ? extensionForLanguage(artifact.language)
      : (KINDS[artifact.type]?.extension ?? extensionForLanguage(artifact.language))
  return `${base}.${extension}`
}
