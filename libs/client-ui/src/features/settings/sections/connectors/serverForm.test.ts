import { describe, expect, it } from 'vitest'
import { scopeHoldsSecrets, serverFormEntry, serverFormValues } from './serverForm'

const blank = serverFormValues()

describe('serverFormEntry', () => {
  it('writes https, or http on loopback, and never credentials in the URL', () => {
    const remote = { ...blank, name: 'custom-server', url: 'http://remote.example/mcp' }
    expect(serverFormEntry(remote, 'global')).toEqual({
      problem: 'The connector URL must use https (plain http only for localhost).',
    })
    expect(
      serverFormEntry({ ...remote, url: 'https://user:password@example.com/mcp' }, 'global'),
    ).toEqual({
      problem: 'The connector URL must use https and must not contain a user name or password.',
    })
    expect(
      serverFormEntry(
        { ...remote, url: 'http://127.0.0.1:8080/mcp', authorization: ' Bearer host-secret ' },
        'global',
      ),
    ).toEqual({
      name: 'custom-server',
      config: {
        url: 'http://127.0.0.1:8080/mcp',
        headers: { Authorization: 'Bearer host-secret' },
      },
    })
  })

  it('keeps each command argument whole, one per line', () => {
    const values = {
      ...blank,
      name: 'host-command',
      transport: 'stdio' as const,
      command: 'npx',
      args: '-y\r\n@vendor/mcp-server\n\n/path with space\n',
    }
    expect(serverFormEntry(values, 'project')).toEqual({
      name: 'host-command',
      config: { command: 'npx', args: ['-y', '@vendor/mcp-server', '/path with space'] },
    })
    expect(serverFormEntry({ ...values, command: 'npx\n-y' }, 'global')).toHaveProperty('problem')
  })

  it('refuses a bad name, and secrets in a folder', () => {
    expect(serverFormEntry({ ...blank, name: 'a b', url: 'https://x.test' }, 'global')).toEqual({
      problem: 'Use a server name with letters, numbers, underscores or hyphens.',
    })
    const secret = { ...blank, name: 'docs', url: 'https://x.test', authorization: 'Bearer x' }
    expect(serverFormEntry(secret, 'project')).toHaveProperty('problem')
    expect(scopeHoldsSecrets('project')).toBe(false)
    expect(scopeHoldsSecrets('global')).toBe(true)
  })

  it('keeps the keys it does not show, and drops what the other transport cannot use', () => {
    const defined = {
      url: 'https://x.test',
      headers: { Authorization: 'Bearer kept' },
      oauth: { clientId: 'id' },
      exposure: 'direct' as const,
      toolExposure: { a: 'hidden' as const },
    }
    const values = serverFormValues({ name: 'docs', defined })
    expect(values).toMatchObject({ transport: 'https', url: 'https://x.test', exposure: 'direct' })
    expect(serverFormEntry(values, 'global', defined)).toEqual({ name: 'docs', config: defined })
    expect(
      serverFormEntry({ ...values, transport: 'stdio', command: 'tools' }, 'global', defined),
    ).toEqual({
      name: 'docs',
      config: { command: 'tools', exposure: 'direct', toolExposure: { a: 'hidden' } },
    })
  })
})
