import { expect, it } from 'vitest'
import { parseMcpInspection } from './mcp-inspection'

const tool = {
  name: 'get_incident',
  description: 'Find the on-call responder',
  exposure: 'codemode',
}
const payload = { version: 1, server: { name: 'pagerduty', state: 'connected', tools: [tool] } }

it('projects display metadata only, dropping raw configuration and schema extras', () => {
  expect(
    parseMcpInspection(
      {
        ...payload,
        server: {
          ...payload.server,
          headers: { Authorization: 'secret' },
          tools: [{ ...tool, inputSchema: { secret: true } }],
        },
      },
      'pagerduty',
    ),
  ).toEqual(payload.server)
})
it('preserves sanitized native errors and rejects mismatched or future reports', () => {
  expect(
    parseMcpInspection(
      {
        version: 1,
        server: {
          name: 'pagerduty',
          state: 'needs-auth',
          tools: [],
          error: { code: 'needs_auth', message: 'Sign in required.' },
        },
      },
      'pagerduty',
    )?.error,
  ).toBe('Sign in required.')
  expect(parseMcpInspection(payload, 'linear')).toBeNull()
  expect(parseMcpInspection({ ...payload, version: 2 }, 'pagerduty')).toBeNull()
})
it.each([null, {}, 'tool', { ...tool, exposure: 'invalid' }, { ...tool, name: '' }])(
  'rejects invalid tools: %j',
  (bad) => {
    expect(
      parseMcpInspection({ ...payload, server: { ...payload.server, tools: [bad] } }, 'pagerduty'),
    ).toBeNull()
  },
)
it('bounds descriptions and refuses duplicate tools', () => {
  const report = parseMcpInspection(
    {
      ...payload,
      server: { ...payload.server, tools: [{ ...tool, description: 'x'.repeat(9000) }] },
    },
    'pagerduty',
  )
  expect(report?.tools[0]?.description).toHaveLength(8000)
  expect(
    parseMcpInspection(
      { ...payload, server: { ...payload.server, tools: [tool, tool] } },
      'pagerduty',
    ),
  ).toBeNull()
})
