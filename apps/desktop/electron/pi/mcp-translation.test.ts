import { describe, expect, it } from 'vitest'
import { isRecord, mergeAdapterEntry, translateEntry, type Entry } from './mcp-translation'

const url = 'https://server.test/mcp'

describe('mergeAdapterEntry', () => {
  it('copies a first entry and does not mutate either merge input', () => {
    const first = { command: 'server', args: ['first'] }
    expect(mergeAdapterEntry(undefined, first)).toEqual(first)
    expect(mergeAdapterEntry(undefined, first)).not.toBe(first)
    const next = { args: ['next'], disabled: true }
    expect(mergeAdapterEntry(first, next)).toEqual({ command: 'server', ...next })
    expect(first).toEqual({ command: 'server', args: ['first'] })
    expect(next).toEqual({ args: ['next'], disabled: true })
  })

  it('drops every URL-bound credential when the endpoint changes', () => {
    const bound = {
      headers: { Authorization: 'old' },
      bearerToken: 'old',
      bearerTokenEnv: 'OLD',
      bearerTokenStore: true,
      requestHeadersCommand: 'old',
      caFile: '/old',
      auth: { provider: 'old' },
      oauth: { clientId: 'old' },
    }
    expect(mergeAdapterEntry({ url, ...bound }, { url })).toEqual({ url, ...bound })
    expect(
      mergeAdapterEntry({ url, ...bound }, { url: 'https://new.test', bearerToken: 'new' }),
    ).toEqual({ url: 'https://new.test', bearerToken: 'new' })
  })

  it('resets transport-specific fields but keeps unrelated adapter options', () => {
    expect(
      mergeAdapterEntry(
        { url, headers: {}, httpTransport: 'x', socket: '/sock', disabled: true },
        { command: 'local' },
      ),
    ).toEqual({ command: 'local', disabled: true })
    expect(
      mergeAdapterEntry(
        {
          command: 'local',
          args: [],
          env: {},
          cwd: '/cwd',
          inheritEnv: false,
          literalEnv: true,
          socket: '/sock',
          disabled: true,
        },
        { url },
      ),
    ).toEqual({ url, disabled: true })
  })
})

describe('translateEntry authentication', () => {
  it('copies headers and lets a literal token take precedence over environment and stored tokens', () => {
    const entry = {
      url,
      headers: { Authorization: 'old', Other: 'keep' },
      bearerToken: 'literal',
      bearerTokenEnv: 'TOKEN',
      bearerTokenStore: true,
    }
    expect(translateEntry('server', entry, 'global')).toEqual({
      config: { url, headers: { Authorization: 'Bearer literal', Other: 'keep' } },
      notes: ['The bearer token is now an Authorization header.'],
    })
    expect(entry.headers.Authorization).toBe('old')
  })

  it('uses environment references without reading credentials', () => {
    expect(
      translateEntry('server', { url, bearerTokenEnv: 'TOKEN', bearerTokenStore: true }, 'global'),
    ).toEqual({
      config: { url, headers: { Authorization: 'Bearer ${TOKEN}' } },
      notes: ['The bearer token is read from $TOKEN through an Authorization header.'],
    })
  })

  it('retains global provider auth and leaves automatic OAuth implicit', () => {
    expect(translateEntry('server', { url, auth: { provider: 'provider' } }, 'global')).toEqual({
      config: { url, auth: { provider: 'provider' } },
      notes: [],
    })
    expect(translateEntry('server', { url, auth: 'oauth', headers: {} }, 'project')).toEqual({
      config: { url },
      notes: [],
    })
  })
})

describe('translateEntry OAuth', () => {
  it.each([
    ['http://localhost:1234/callback', 'http://localhost:1234/callback'],
    ['http://127.0.0.1:{port}/callback', 'http://127.0.0.1/callback'],
    ['http://[::1]:8080/callback', 'http://[::1]:8080/callback'],
  ])('accepts the loopback redirect %s', (redirectUri, callbackUrl) => {
    expect(translateEntry('server', { url, oauth: { redirectUri } }, 'global')).toEqual({
      config: { url, oauth: { callbackUrl } },
      notes: [],
    })
  })

  it.each(['https://localhost/callback', 'http://remote.test/callback', 'invalid'])(
    'drops the non-loopback redirect %s',
    (redirectUri) => {
      expect(translateEntry('server', { url, oauth: { redirectUri } }, 'global')).toEqual({
        config: { url },
        notes: [`pi needs a loopback redirect; ${redirectUri} was dropped.`],
      })
    },
  )

  it('passes all pi OAuth client keys but never copies adapter tokens or unknown keys', () => {
    const oauth = {
      clientId: 'id',
      clientSecret: 'secret',
      callbackPort: 1234,
      callbackUrl: 'http://localhost/cb',
      scope: 'read',
      clientName: 'client',
      clientRegistration: 'cimd',
      authServerMetadataUrl: 'https://metadata.test',
    }
    expect(
      translateEntry(
        'server',
        {
          url,
          oauth: {
            ...oauth,
            accessToken: 'do-not-copy',
            refreshToken: 'do-not-copy',
            grantType: 'authorization_code',
            extra: 1,
          },
        },
        'global',
      ),
    ).toEqual({
      config: { url, oauth },
      notes: [
        'Dropped oauth.accessToken, which pi does not support.',
        'Dropped oauth.refreshToken, which pi does not support.',
        'Dropped oauth.extra, which pi does not support.',
      ],
    })
  })

  it('keeps OAuth property order when callbackUrl and redirectUri both exist', () => {
    const redirectUri = 'http://localhost/translated'
    const callbackUrl = 'http://localhost/original'
    expect(
      translateEntry('server', { url, oauth: { callbackUrl, redirectUri } }, 'global'),
    ).toMatchObject({ config: { oauth: { callbackUrl: redirectUri } } })
    expect(
      translateEntry('server', { url, oauth: { redirectUri, callbackUrl } }, 'global'),
    ).toMatchObject({ config: { oauth: { callbackUrl } } })
  })
})

describe('translateEntry exposure', () => {
  it.each([
    [true, 'direct'],
    ['search', 'deferred'],
    [false, undefined],
  ])('maps directTools %s', (directTools, exposure) => {
    expect(translateEntry('server', { command: 'server', directTools }, 'global')).toEqual({
      config: { command: 'server', ...(exposure ? { exposure } : {}) },
      notes: [],
    })
  })

  it('applies direct lists, inclusion defaults and exclusion precedence without mutating input', () => {
    const toolExposure = { pinned: 'hidden', read: 'deferred' }
    expect(
      translateEntry(
        'server',
        {
          command: 'server',
          exposure: 'direct',
          toolExposure,
          directTools: ['read', 'drop', 7],
          includeTools: ['read', 'pinned', 'new', 9],
          excludeTools: ['drop', 4],
        },
        'global',
      ),
    ).toEqual({
      config: {
        command: 'server',
        exposure: 'hidden',
        toolExposure: {
          pinned: 'hidden',
          read: 'direct',
          drop: 'hidden',
          new: 'direct',
        },
      },
      notes: ["Tool filters became toolExposure rules; they match the server's own tool names."],
    })
    expect(toolExposure).toEqual({ pinned: 'hidden', read: 'deferred' })
  })

  it('removes codemode defaults and empty per-tool rules', () => {
    expect(
      translateEntry(
        'server',
        { command: 'server', exposure: 'codemode', toolExposure: {} },
        'global',
      ),
    ).toEqual({ config: { command: 'server' }, notes: [] })
    expect(translateEntry('server', { command: 'server', exposure: 'unknown' }, 'global')).toEqual({
      config: { command: 'server' },
      notes: [],
    })
  })
})

describe('translateEntry remaining rules', () => {
  it('preserves pi fields, rounds timeouts, and lets disabled override enabled', () => {
    const config = {
      type: 'stdio',
      command: 'server',
      args: ['arg'],
      env: { A: '1' },
      cwd: '/cwd',
      description: 'description',
      timeout: 99,
    }
    expect(
      translateEntry(
        'server',
        { ...config, enabled: true, disabled: true, requestTimeoutMs: 1001 },
        'global',
      ),
    ).toEqual({
      config: { ...config, enabled: false, timeout: 2 },
      notes: [],
    })
    expect(
      translateEntry(
        'server',
        { command: 'server', timeout: 99, requestTimeoutMs: 0, disabled: false },
        'global',
      ),
    ).toEqual({ config: { command: 'server', timeout: 99 }, notes: [] })
  })

  it('silently drops adapter-only settings and lists unknown keys in input order', () => {
    expect(
      translateEntry(
        'server',
        {
          command: 'server',
          lifecycle: 'eager',
          idleTimeout: 1,
          toolPrefix: 'prefix',
          debug: true,
          trace: true,
          openUi: true,
          protocolVersion: 'v',
          searchKeywords: [],
          exposeResources: true,
          httpTransport: 'http',
          pluginDataDir: '/tmp',
          literalEnv: true,
          inheritEnv: true,
          approveTools: false,
          second: 2,
          first: 1,
        },
        'global',
      ),
    ).toEqual({
      config: { command: 'server' },
      notes: ['Dropped second, first, which pi does not read.'],
    })
  })

  it.each<[string, Entry, string]>([
    ['socket', { socket: '/tmp/socket' }, 'rmcp-mux socket'],
    ['invalid name', { command: 'server' }, 'invalid server name'],
    ['server', { type: 'sse', url }, 'legacy SSE transport'],
    ['server', { url: 'file:///tmp/file' }, 'url must be an http or https URL'],
    ['server', {}, 'needs either "command"'],
  ])('validates %s after translation', (name, entry, reason) => {
    expect(translateEntry(name, entry, 'global')).toEqual({ skip: expect.stringContaining(reason) })
  })

  it('recognizes only non-array objects as entries', () => {
    expect([{}, [], null, 'text', 1].map(isRecord)).toEqual([true, false, false, false, false])
  })
})
