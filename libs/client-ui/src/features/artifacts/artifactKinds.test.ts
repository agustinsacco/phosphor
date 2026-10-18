import { describe, it, expect } from 'vitest'
import { artifactGlyph, artifactLanguage, suggestedFileName } from './artifactKinds'
import type { Artifact } from '@/stores/artifacts'

const ALL_TYPES: Artifact['type'][] = ['html', 'svg', 'mermaid', 'chart', 'markdown', 'code']

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'my-artifact',
    type: 'code',
    title: 'Test',
    versions: [],
    ...overrides,
  } as Artifact
}

describe('artifactGlyph', () => {
  it.each([
    ['html', '🌐'],
    ['svg', '🎨'],
    ['mermaid', '📊'],
    ['chart', '📈'],
    ['markdown', '📄'],
    ['code', '⌨️'],
  ] as const)('maps %s to %s', (type, glyph) => {
    expect(artifactGlyph(type)).toBe(glyph)
  })

  it('returns a glyph for every known type', () => {
    for (const type of ALL_TYPES) expect(artifactGlyph(type)).toBeTruthy()
  })
})

describe('artifactLanguage', () => {
  it.each([
    ['html', 'html'],
    ['svg', 'xml'],
    ['mermaid', 'mermaid'],
    ['chart', 'json'],
    ['markdown', 'markdown'],
  ] as const)('maps %s to language %s', (type, language) => {
    expect(artifactLanguage(artifact({ type }))).toBe(language)
  })

  it('uses the declared language for code artifacts', () => {
    expect(artifactLanguage(artifact({ type: 'code', language: 'python' }))).toBe('python')
  })

  it('falls back to text for a code artifact with no language', () => {
    expect(artifactLanguage(artifact({ type: 'code' }))).toBe('text')
  })
})

describe('suggestedFileName', () => {
  it.each([
    ['html', 'my-artifact.html'],
    ['svg', 'my-artifact.svg'],
    ['mermaid', 'my-artifact.mmd'],
    ['chart', 'my-artifact.json'],
    ['markdown', 'my-artifact.md'],
  ] as const)('names a %s artifact %s', (type, expected) => {
    expect(suggestedFileName(artifact({ type }))).toBe(expected)
  })

  it.each([
    ['typescript', 'ts'],
    ['javascript', 'js'],
    ['python', 'py'],
    ['bash', 'sh'],
    ['yaml', 'yml'],
  ])('maps code language %s to .%s', (language, ext) => {
    expect(suggestedFileName(artifact({ type: 'code', language }))).toBe(`my-artifact.${ext}`)
  })

  it('is case-insensitive about the language name', () => {
    expect(suggestedFileName(artifact({ type: 'code', language: 'TypeScript' }))).toBe(
      'my-artifact.ts',
    )
  })

  it('falls back to .txt for an unknown code language', () => {
    expect(suggestedFileName(artifact({ type: 'code', language: 'brainfuck' }))).toBe(
      'my-artifact.txt',
    )
  })

  it('sanitizes characters that are unsafe in filenames', () => {
    const name = suggestedFileName(artifact({ id: 'my/weird:id!', type: 'markdown' }))
    expect(name).toBe('my-weird-id-.md')
  })

  it('produces a usable name for every type', () => {
    for (const type of ALL_TYPES) {
      expect(suggestedFileName(artifact({ type }))).toMatch(/^my-artifact\.[a-z]+$/)
    }
  })
})
