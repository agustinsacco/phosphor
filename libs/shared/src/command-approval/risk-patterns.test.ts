import { describe, expect, it } from 'vitest'
import { RISK_PATTERNS } from './risk-patterns'

const fixtures = [
  {
    id: 'rm-recursive',
    positive: ['rm -rf build', 'rm -R build', 'rm --recursive build', 'rm --force file'],
    negative: 'rm file',
  },
  { id: 'sudo', positive: ['sudo true'], negative: 'pseudocode' },
  { id: 'su', positive: ['su root'], negative: 'suspend' },
  { id: 'shred', positive: ['shred secret', 'truncate -s 0 file'], negative: 'shredder file' },
  {
    id: 'force-push',
    positive: ['git push origin main --force', 'git push --force-with-lease'],
    negative: 'git push origin main; echo --force',
  },
  { id: 'reset-hard', positive: ['git reset --hard HEAD'], negative: 'git reset --soft HEAD' },
  { id: 'kill', positive: ['kill 1', 'pkill worker', 'killall worker'], negative: 'skill list' },
  { id: 'aws', positive: ['aws s3 ls'], negative: 'aws' },
  {
    id: 'open-permissions',
    positive: ['chmod -R 777 build', 'chown user:777 file'],
    negative: 'chmod 755 file; echo 777',
  },
  {
    id: 'service',
    positive: [
      'systemctl start worker',
      'systemctl stop worker',
      'systemctl restart worker',
      'systemctl enable worker',
      'systemctl disable worker',
      'service worker start',
      'service worker stop',
      'service worker restart',
    ],
    negative: 'systemctl status worker; service worker status',
  },
]

describe('command-approval risk-patterns', () => {
  it('declares each ID exactly once in stable order', () => {
    const ids = RISK_PATTERNS.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'rm-recursive',
      'sudo',
      'su',
      'shred',
      'force-push',
      'reset-hard',
      'kill',
      'aws',
      'open-permissions',
      'service',
    ])
    expect(fixtures.map(({ id }) => id)).toEqual(ids)
  })

  it.each(fixtures)('matches positives and rejects a negative for $id', (fixture) => {
    const entry = RISK_PATTERNS.find(({ id }) => id === fixture.id)
    expect(entry).toBeDefined()
    const pattern = entry!.pattern
    for (const command of fixture.positive) {
      expect(new RegExp(pattern.source, pattern.flags).test(command)).toBe(true)
    }
    expect(new RegExp(pattern.source, pattern.flags).test(fixture.negative)).toBe(false)
  })
})
