/**
 * Curated pi packages Phosphor recommends. Versions are pinned once reviewed —
 * pi packages run with full system access, so an entry here is a statement
 * that we've read that version's source.
 *
 * The full ecosystem lives at https://pi.dev/packages; this list is only the
 * doorway.
 */
export interface CatalogueEntry {
  /** Spec passed to `pi install`. */
  spec: string
  name: string
  description: string
  docsUrl: string
  /** Binary this package needs on PATH, checked via packages:detect. */
  requiresBinary?: 'claude'
}

export const PACKAGE_CATALOGUE: CatalogueEntry[] = [
  {
    spec: 'npm:@saccolabs/pi-claude-cli',
    name: 'Claude Code provider',
    description:
      'Use your Claude Pro/Max subscription as a model provider — routes LLM calls through the Claude Code CLI. Claude models appear in the model picker.',
    docsUrl: 'https://github.com/agustinsacco/pi-claude-cli',
    requiresBinary: 'claude',
  },
  {
    spec: 'npm:pi-mcp-adapter',
    name: 'MCP adapter',
    description:
      'Connect Model Context Protocol servers; their tools appear in chat as ordinary tool calls. Configured in the MCP tab.',
    docsUrl: 'https://www.npmjs.com/package/pi-mcp-adapter',
  },
  {
    spec: 'npm:pi-web-access',
    name: 'Web access',
    description: 'Web search, URL fetching, PDF extraction and YouTube understanding for sessions.',
    docsUrl: 'https://www.npmjs.com/package/pi-web-access',
  },
  {
    spec: 'npm:pi-subagents',
    name: 'Subagents',
    description: 'Delegate tasks to parallel or chained pi subagents with isolated contexts.',
    docsUrl: 'https://www.npmjs.com/package/pi-subagents',
  },
  {
    spec: 'npm:@injaneity/pi-computer-use',
    name: 'Computer use',
    description:
      'Desktop app control for macOS, Windows, and Linux — observe windows, search UI, click, type, and scroll through accessible interfaces.',
    docsUrl: 'https://github.com/injaneity/pi-computer-use',
  },
]

/** True when a settings `packages` entry already covers a catalogue spec. */
export function isCatalogueEntryInstalled(entrySpec: string, installedSpecs: string[]): boolean {
  const bareName = entrySpec.replace(/^npm:/, '')
  return installedSpecs.some((spec) => spec.replace(/^npm:/, '').startsWith(bareName))
}
