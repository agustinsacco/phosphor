import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { ConnectorAuthState } from '@shared/models'
import {
  cancelMcpLogin,
  listMcpServers,
  loginMcpServer,
  logoutMcpServer,
  parseMcpList,
  type PiCli,
} from './mcp-cli'

const cli: PiCli = {
  binaryPath: process.execPath,
  prefixArgs: [join(__dirname, '__fixtures__', 'fake-pi-mcp.cjs')],
  cwd: __dirname,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>,
}

describe('listMcpServers', () => {
  it('reads pi’s report even though pi exits 1, dropping what does not parse', async () => {
    const result = await listMcpServers(cli)
    expect(result).toEqual({
      ok: true,
      servers: [
        {
          name: 'up',
          scope: 'global',
          source: '/a/mcp.json',
          enabled: true,
          exposure: 'codemode',
          transport: 'https://up.test/mcp',
          state: 'connected',
          tools: ['a', 'b'],
        },
        {
          name: 'locked',
          scope: 'global',
          source: '/a/mcp.json',
          enabled: true,
          exposure: 'direct',
          transport: 'https://l.test/mcp',
          state: 'needs-auth',
          tools: [],
        },
        {
          name: 'odd',
          scope: 'global',
          source: '',
          enabled: true,
          exposure: 'codemode',
          transport: '',
          state: 'failed',
          tools: [],
        },
      ],
      errors: ['/a/mcp.json: server "x y" is bad'],
      note: 'project ignored',
    })
  })

  it('fails with pi’s own words when there is no report', () => {
    expect(parseMcpList('', 'Unknown mcp command "list".\n')).toEqual({
      ok: false,
      message: 'Unknown mcp command "list".',
    })
    expect(parseMcpList('{"errors":[]}', '')).toEqual({
      ok: false,
      message: 'pi mcp list answered without servers.',
    })
  })

  it('reports a binary that cannot start', async () => {
    const result = await listMcpServers({ ...cli, binaryPath: '/nonexistent/pi', prefixArgs: [] })
    expect(result.ok).toBe(false)
  })
})

describe('loginMcpServer', () => {
  const states = async (name: string): Promise<ConnectorAuthState[]> => {
    const seen: ConnectorAuthState[] = []
    await loginMcpServer(cli, name, (state) => seen.push(state))
    return seen
  }

  it('surfaces pi’s URL, then the verdict from its exit code', async () => {
    expect(await states('linear')).toEqual([
      { phase: 'starting' },
      { phase: 'awaiting-browser', authorizationUrl: 'https://auth.test/authorize?server=linear' },
      { phase: 'connected' },
    ])
  })

  it('fails with pi’s last error line', async () => {
    expect(await states('broken')).toEqual([
      { phase: 'starting' },
      { phase: 'failed', message: 'MCP server "broken" failed to connect: ECONNREFUSED' },
    ])
  })

  it('cancels by killing pi, reporting nothing after the cancel', async () => {
    const seen: ConnectorAuthState[] = []
    const done = loginMcpServer(cli, 'slow', (state) => {
      seen.push(state)
      if (state.phase === 'awaiting-browser') cancelMcpLogin('slow')
    })
    await done
    expect(seen.map((s) => s.phase)).toEqual(['starting', 'awaiting-browser'])
  })
})

describe('logoutMcpServer', () => {
  it('returns pi’s answer', async () => {
    expect(await logoutMcpServer(cli, 'linear')).toEqual({
      ok: true,
      message: 'Signed out of MCP server "linear".',
    })
  })
})
