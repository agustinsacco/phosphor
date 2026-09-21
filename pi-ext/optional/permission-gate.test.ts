import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import permissionGate, { permissionDecision } from './permission-gate'

const prefix =
  'env -u AWS_PROFILE AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url=http://localhost:4566'
const listing = `${prefix} s3api list-objects-v2 --bucket knowledge-artifacts-local --prefix spreadsheets/ --query 'Contents[].{Key:Key,Size:Size,Modified:LastModified}' --output json`
const download = `${prefix} s3 cp 's3://knowledge-artifacts-local/spreadsheets/augment-brokerage/internal/global/9e6906f41c438ca0/manifest.json' - --only-show-errors > /tmp/nrs-manifest.json`
const compound = `${download}; python3 - <<'PY'
import json,collections,os
m=json.load(open('/tmp/nrs-manifest.json'))
r=m['regions']
print(json.dumps({
 'status':m.get('status'),'rejection':m.get('rejection'),'regions':len(r),
 'roles':dict(collections.Counter(x.get('role') for x in r)),
 'worksheets':len(set(x.get('worksheet') for x in r)),
 'worksheetNames':sorted(set(x.get('worksheet') for x in r)),
 'tableRows':sum(x.get('rowCount') or 0 for x in r if x.get('role')=='table'),
 'regionErrors':[{'worksheet':x.get('worksheet'),'error':x.get('error')} for x in r if x.get('error')],
},indent=2))
PY
printf '\\nArtifact totals:\\n'; ${prefix} s3api list-objects-v2 --bucket knowledge-artifacts-local --prefix spreadsheets/augment-brokerage/internal/global/9e6906f41c438ca0/ --query '{Count:KeyCount,Bytes:sum(Contents[].Size)}' --output json`

describe('LocalStack exception', () => {
  it.each([
    listing,
    compound,
    download,
    listing.replace('localhost', '127.0.0.1'),
    listing.replace('--endpoint-url=', '--endpoint-url '),
  ])('allows literal local S3 reads: %s', (command) => {
    expect(permissionDecision(command)).toBe('allow')
  })

  it.each([
    'aws s3 ls',
    `${listing}; aws s3 ls --profile prod`,
    `aws sts get-caller-identity --profile staging; ${listing}`,
    `${listing} && aws s3 ls`,
    `${listing} | aws s3 cp - s3://production/key`,
    compound.replace(/; env -u AWS_PROFILE/, '; aws s3 ls; env -u AWS_PROFILE'),
    listing.replace('localhost', 'localhost.example.com'),
    listing.replace('localhost:4566', 'localhost:4566@prod.example.com'),
    listing.replace('4566', '443'),
    listing.replace('http://', 'https://'),
    listing.replace('--endpoint-url=http://localhost:4566 ', ''),
    listing.replace('http://localhost:4566', '$ENDPOINT'),
    listing.replace('http://localhost:4566', '$(echo http://localhost:4566)'),
    listing.replace('AWS_ACCESS_KEY_ID=test', 'AWS_ACCESS_KEY_ID=real'),
    listing.replace('AWS_SECRET_ACCESS_KEY=test', 'AWS_SECRET_ACCESS_KEY=real'),
    listing.replace('-u AWS_PROFILE ', ''),
    listing.replace('AWS_DEFAULT_REGION=us-east-1', 'AWS_PROFILE=prod'),
    ...[
      '--profile prod',
      '--prof prod',
      '--endpoint-url=https://s3.amazonaws.com',
      '--end https://s3.amazonaws.com',
      '--cli-input-json file:///tmp/input.json',
      '--bucket another',
    ].map((flags) => `${listing} ${flags}`),
    `${prefix} s3 rm s3://knowledge-artifacts-local/key`,
    `${prefix} s3 cp /tmp/file s3://knowledge-artifacts-local/key`,
    listing.replace('knowledge-artifacts-local', 'arn:aws:s3:us-east-1:123:accesspoint/test'),
    download.replace(
      's3://knowledge-artifacts-local/',
      's3://arn:aws:s3:us-east-1:123:accesspoint/test/',
    ),
    `${listing} --query "$(aws sts get-caller-identity)"`,
    `echo '${listing}'`,
    `bash -c '${listing}'`,
    `python3 - <<'PY'\nprint(${JSON.stringify(listing)})\nPY`,
    `${listing} \\\n --profile prod`,
    ...['*', '?', '[a-z]*', '~user', '`echo value`'].map(
      (value) => `${listing.replace(/ --query .*/, '')} --query ${value}`,
    ),
    `${listing}; echo "unterminated`,
    `${listing}; python3 - <<'PY'\nunterminated`,
    `${listing}; python3 - <<PY\n$COMMAND\nPY`,
  ])('keeps approval for unsafe or unsupported input: %s', (command) => {
    expect(permissionDecision(command)).toBe('ask')
  })

  it.each([
    'sudo true',
    'rm -rf /tmp/test',
    'git push --force',
    'git reset --hard',
    'kill 123',
    'pkill worker',
    'killall worker',
    'chmod 777 /tmp/test',
    'systemctl restart service',
    'service nginx stop',
    'su root',
  ])('preserves other approvals: %s', (command) => {
    expect(permissionDecision(`${listing}; ${command}`)).toBe('ask')
  })

  it.each(['shred /tmp/test', 'truncate -s 0 /tmp/test'])(
    'preserves hard blocks: %s',
    (command) => {
      expect(permissionDecision(`${listing}; ${command}`)).toBe('block')
    },
  )
})

it.skipIf(process.platform === 'win32')(
  'runs both examples against a local AWS stub, never the real CLI',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'permission-gate-'))
    try {
      writeFileSync(
        join(dir, 'aws'),
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify({
  args: process.argv.slice(2), profile: process.env.AWS_PROFILE,
  key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY,
}) + '\\n');
console.log(JSON.stringify({regions: []}));
`,
        { mode: 0o700 },
      )
      execFileSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `${listing}\n${compound}`.replaceAll(
            '/tmp/nrs-manifest.json',
            join(dir, 'manifest.json'),
          ),
        ],
        {
          env: { PATH: `${dir}:/usr/bin:/bin`, AWS_PROFILE: 'prod' },
        },
      )
      const calls = readFileSync(join(dir, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(calls).toHaveLength(3)
      for (const call of calls) {
        expect(call).toMatchObject({ key: 'test', secret: 'test' })
        expect(call.profile).toBeUndefined()
        expect(call.args[0]).toBe('--endpoint-url=http://localhost:4566')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

it('enforces approval, cancellation, non-UI blocks and the local exception at the hook', async () => {
  const on = vi.fn<Parameters<typeof permissionGate>[0]['on']>()
  permissionGate({ on })
  const handler = on.mock.calls[0]![1]
  const select = vi.fn().mockResolvedValue('No')
  const ctx = { hasUI: true, ui: { select } }
  const call = (command: string) => handler({ toolName: 'bash', input: { command } }, ctx)
  expect(await call(listing)).toBeUndefined()
  expect(select).not.toHaveBeenCalled()
  expect(await call('aws s3 ls')).toMatchObject({ block: true })
  select.mockResolvedValue(undefined)
  expect(await call('aws s3 ls')).toMatchObject({ block: true })
  select.mockResolvedValue('Yes')
  expect(await call('aws s3 ls')).toBeUndefined()
  select.mockClear()
  ctx.hasUI = false
  expect(await call('aws s3 ls')).toMatchObject({ block: true })
  expect(await call(compound)).toBeUndefined()
  expect(await call('shred /tmp/test')).toMatchObject({ block: true })
  expect(select).not.toHaveBeenCalled()
  expect(await handler({ toolName: 'read', input: {} }, ctx)).toBeUndefined()
})
