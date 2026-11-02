import { describe, expect, it } from 'vitest'
import { mcpSecretProblem, mcpUrlProblem, mcpWriteProblem } from './mcp-write-policy'

describe('mcp write policy', () => {
  it('allows https and loopback http, never userinfo or another scheme', () => {
    for (const url of [
      'https://d.test/mcp',
      'http://localhost:3/x',
      'http://[::1]:3',
      'http://127.0.0.1',
    ])
      expect(mcpUrlProblem(url)).toBeNull()
    for (const url of [
      'http://d.test',
      'https://u:p@d.test',
      'https://u@d.test',
      'file:///x',
      'nope',
    ])
      expect(mcpUrlProblem(url)).toBeTruthy()
  })
  it('bans secrets only in folder scope', () => {
    const secret = { headers: { A: 'b' } }
    expect(mcpSecretProblem(secret, 'global')).toBeNull()
    expect(mcpSecretProblem(secret, 'project')).toMatch(/machine connector/)
    expect(mcpSecretProblem({ oauth: { clientId: 'x' } }, 'project')).toBeNull()
  })
  it('checks the server and OAuth URLs and the scope together', () => {
    expect(mcpWriteProblem({ command: 'node', args: ['x'] }, 'project')).toBeNull()
    expect(
      mcpWriteProblem(
        { url: 'https://d.test', oauth: { authServerMetadataUrl: 'http://e.test' } },
        'global',
      ),
    ).toMatch(/https/)
    expect(mcpWriteProblem({ command: 'node', env: { K: 'v' } }, 'project')).toMatch(/folder/)
  })
})
