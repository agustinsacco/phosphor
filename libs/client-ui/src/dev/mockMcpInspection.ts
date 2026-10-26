import type { McpListResult, McpServerReport } from '@shared/mcp'
import type { McpCheckResult } from '@shared/mcp-inspection'

export function mockMcpInspection(name: string): McpCheckResult {
  const tools =
    name === 'linear'
      ? [
          {
            name: 'get_issue',
            description: 'Read an issue by identifier.',
            exposure: 'direct' as const,
          },
        ]
      : []
  return {
    ok: true,
    snapshot: {
      checkedAt: Date.now(),
      discoveredAt: Date.now(),
      tools,
      report: {
        name,
        state: name === 'notion' ? 'needs-auth' : name === 'snowflake' ? 'disabled' : 'connected',
        tools,
      },
    },
  }
}

export function mockMcpList(): Promise<McpListResult> {
  const servers: McpServerReport[] = [
    {
      name: 'linear',
      scope: 'global',
      source: '/Users/dev/.pi/agent/mcp.json',
      enabled: true,
      exposure: 'codemode',
      transport: 'https://mcp.linear.app/mcp',
      state: 'connected',
      tools: ['get_issue', 'save_issue', 'list_issues'],
    },
    {
      name: 'notion',
      scope: 'global',
      source: '/Users/dev/.pi/agent/mcp.json',
      enabled: true,
      exposure: 'codemode',
      transport: 'https://mcp.notion.com/mcp',
      state: 'needs-auth',
      tools: [],
    },
  ]
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true, servers, errors: [] }), 900))
}
