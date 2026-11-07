import { CLAUDE_PROVIDER_PACKAGE } from './models/claude-provider'

/**
 * The pi packages Phosphor recommends, on every machine. pi packages run with
 * full system access, so an entry here says we have read that package's
 * source. The full ecosystem lives at https://pi.dev/packages; this list is
 * only the doorway.
 */
export interface StandardPackage {
  /** The npm package name; a machine's package list is matched by it. */
  name: string
  /** What `pi install` is given. */
  spec: string
  title: string
  description: string
  docsUrl: string
  /** A binary the package needs on PATH. */
  requiresBinary?: 'claude'
  /** Works without a desktop session: Hosts offer it and guided Host setup installs it. */
  headless: boolean
}

export const STANDARD_PACKAGES: readonly StandardPackage[] = [
  {
    name: CLAUDE_PROVIDER_PACKAGE,
    spec: `npm:${CLAUDE_PROVIDER_PACKAGE}`,
    title: 'Claude Code provider',
    description:
      'Use your Claude Pro/Max subscription as a model provider — routes LLM calls through the Claude Code CLI. Claude models appear in the model picker.',
    docsUrl: 'https://github.com/agustinsacco/pi-claude-cli',
    requiresBinary: 'claude',
    headless: true,
  },
  {
    name: 'pi-web-access',
    spec: 'npm:pi-web-access',
    title: 'Web access',
    description: 'Web search, URL fetching, PDF extraction and YouTube understanding for sessions.',
    docsUrl: 'https://www.npmjs.com/package/pi-web-access',
    headless: true,
  },
  {
    name: 'pi-subagents',
    spec: 'npm:pi-subagents',
    title: 'Subagents',
    description: 'Delegate tasks to parallel or chained pi subagents with isolated contexts.',
    docsUrl: 'https://www.npmjs.com/package/pi-subagents',
    headless: true,
  },
  {
    name: '@injaneity/pi-computer-use',
    spec: 'npm:@injaneity/pi-computer-use',
    title: 'Computer use',
    description:
      'Desktop app control for macOS, Windows, and Linux — observe windows, search UI, click, type, and scroll through accessible interfaces.',
    docsUrl: 'https://github.com/injaneity/pi-computer-use',
    headless: false,
  },
]

/** The standard packages a machine with no desktop session can run. */
export const HEADLESS_STANDARD_PACKAGES = STANDARD_PACKAGES.filter((entry) => entry.headless)

/**
 * Whether a machine has a package, by name: `installed` when an entry for it
 * is installed, `declared` when pi's settings name it but it is missing (pi
 * installs it at the next session start; a repair installs it now), else `absent`.
 */
export type StandardPackageState = 'installed' | 'declared' | 'absent'

export function standardPackageState(
  name: string,
  packages: readonly { name: string; installed: boolean }[],
): StandardPackageState {
  const matches = packages.filter((pkg) => pkg.name === name)
  if (matches.some((pkg) => pkg.installed)) return 'installed'
  return matches.length > 0 ? 'declared' : 'absent'
}
