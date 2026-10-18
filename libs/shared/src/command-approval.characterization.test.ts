import { describe, expect, it } from 'vitest'
import { analyzeCommand } from './command-approval'

const riskClasses = [
  {
    command: 'rm -rf build',
    id: 'rm-recursive',
    label: 'rm -rf',
    why: 'Deletes files and directories recursively, with no prompt and no undo.',
    severity: 'high',
    text: 'rm -rf',
  },
  {
    command: 'sudo echo hello',
    id: 'sudo',
    label: 'sudo',
    why: 'Runs as root. Everything after it is outside the workspace.',
    severity: 'high',
    text: 'sudo',
  },
  {
    command: 'su root',
    id: 'su',
    label: 'su',
    why: 'Switches to another user account.',
    severity: 'high',
    text: 'su',
  },
  {
    command: 'shred secret',
    id: 'shred',
    label: 'shred / truncate',
    why: 'Destroys file contents in place. The data cannot be recovered.',
    severity: 'high',
    text: 'shred',
  },
  {
    command: 'git push origin main --force-with-lease',
    id: 'force-push',
    label: 'git push --force',
    why: 'Overwrites remote history. Commits other clones hold can be lost.',
    severity: 'high',
    text: 'git push origin main --force-with-lease',
  },
  {
    command: 'git reset --hard HEAD',
    id: 'reset-hard',
    label: 'git reset --hard',
    why: 'Discards every uncommitted change in the working tree.',
    severity: 'high',
    text: 'git reset --hard',
  },
  {
    command: 'pkill worker',
    id: 'kill',
    label: 'kill',
    why: 'Terminates running processes.',
    severity: 'medium',
    text: 'pkill',
  },
  {
    command: 'aws s3 ls',
    id: 'aws',
    label: 'aws',
    why: 'Reaches live cloud infrastructure with your account credentials.',
    severity: 'medium',
    text: 'aws s',
  },
  {
    command: 'chmod -R 777 build',
    id: 'open-permissions',
    label: 'chmod 777',
    why: 'Grants every user on the machine full read, write and execute access.',
    severity: 'medium',
    text: 'chmod -R 777',
  },
  {
    command: 'systemctl restart worker',
    id: 'service',
    label: 'system services',
    why: 'Starts, stops or re-enables a system service.',
    severity: 'medium',
    text: 'systemctl restart',
  },
]

describe('analyzeCommand characterization', () => {
  it.each(riskClasses)('retains exact $id explanation and range', ({ command, ...risk }) => {
    expect(analyzeCommand(command)).toEqual([
      { ...risk, start: 0, end: risk.text.length, context: 'command' },
    ])
  })

  it('returns identical risks across repeated and interleaved analyses', () => {
    const command = riskClasses.map((risk) => risk.command).join('\n')
    const expected = analyzeCommand(command)
    expect(expected).toHaveLength(10)
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(analyzeCommand(command)).toEqual(expected)
      expect(analyzeCommand('echo ordinary')).toEqual([])
      for (const risk of riskClasses) {
        expect(analyzeCommand(risk.command)).toHaveLength(1)
      }
    }
  })

  it('ranks command before quoted before heredoc, then severity and position', () => {
    const command = [
      "cat <<'EOF'",
      'chmod 777 build',
      'su root',
      'EOF',
      'echo "aws s3 ls; shred secret"',
      'kill 1; git reset --hard HEAD; sudo true; systemctl stop worker',
    ].join('\n')
    expect(analyzeCommand(command).map(({ id, context }) => ({ id, context }))).toEqual([
      { id: 'reset-hard', context: 'command' },
      { id: 'sudo', context: 'command' },
      { id: 'kill', context: 'command' },
      { id: 'service', context: 'command' },
      { id: 'shred', context: 'quoted' },
      { id: 'aws', context: 'quoted' },
      { id: 'su', context: 'heredoc' },
      { id: 'open-permissions', context: 'heredoc' },
    ])
  })

  it('prefers the first command occurrence over earlier heredoc and quoted matches', () => {
    const command = [
      "cat <<'EOF'",
      'sudo heredoc',
      'EOF',
      'echo "sudo quoted"',
      'sudo first; sudo second',
    ].join('\n')
    const start = command.indexOf('sudo first')
    expect(analyzeCommand(command)).toEqual([
      {
        id: 'sudo',
        label: 'sudo',
        why: 'Runs as root. Everything after it is outside the workspace.',
        severity: 'high',
        start,
        end: start + 4,
        text: 'sudo',
        context: 'command',
      },
    ])
  })

  it('keeps the first incidental occurrence even if a later one is quoted', () => {
    const command = "cat <<'EOF'\nsudo heredoc\nEOF\necho 'sudo quoted'"
    expect(analyzeCommand(command)).toEqual([
      {
        id: 'sudo',
        label: 'sudo',
        why: 'Runs as root. Everything after it is outside the workspace.',
        severity: 'high',
        start: command.indexOf('sudo heredoc'),
        end: command.indexOf('sudo heredoc') + 4,
        text: 'sudo',
        context: 'heredoc',
      },
    ])
  })
})
