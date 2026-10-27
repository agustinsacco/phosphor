/** Headless-safe Host baseline. Computer use is deliberately Desktop-only. */
export const HOST_DEFAULT_PACKAGES = [
  {
    name: '@saccolabs/pi-claude-cli',
    title: 'Claude Code provider',
    spec: 'npm:@saccolabs/pi-claude-cli',
    description: 'Use Claude Pro/Max through the official Claude Code CLI.',
  },
  {
    name: 'pi-subagents',
    title: 'Swarm subagents',
    spec: 'npm:pi-subagents',
    description:
      'Delegate parallel or chained work with isolated contexts. Swarm authorization is included with Phosphor.',
  },
  {
    name: 'pi-web-access',
    title: 'Web access',
    spec: 'npm:pi-web-access',
    description: 'Web search, URL fetching and PDF extraction on this Host.',
  },
] as const
