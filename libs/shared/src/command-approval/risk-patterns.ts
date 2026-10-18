interface RiskPattern {
  id: string
  label: string
  why: string
  severity: 'high' | 'medium'
  pattern: RegExp
}

/**
 * Risk classes, mirroring what permission gates in the wild match on.
 *
 * Each entry owns its own explanation because "dangerous" alone is what made
 * the old dialog useless. Patterns are intentionally a little wider than a
 * gate's (e.g. any `rm` flag cluster containing `r` or `f`, not just `-rf`):
 * we are explaining a decision that was already made, so over-matching costs
 * an extra chip while under-matching costs the whole feature.
 */
export const RISK_PATTERNS: ReadonlyArray<RiskPattern> = [
  {
    id: 'rm-recursive',
    label: 'rm -rf',
    why: 'Deletes files and directories recursively, with no prompt and no undo.',
    severity: 'high',
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)/g,
  },
  {
    id: 'sudo',
    label: 'sudo',
    why: 'Runs as root. Everything after it is outside the workspace.',
    severity: 'high',
    pattern: /\bsudo\b/g,
  },
  {
    id: 'su',
    label: 'su',
    why: 'Switches to another user account.',
    severity: 'high',
    pattern: /\bsu\b/g,
  },
  {
    id: 'shred',
    label: 'shred / truncate',
    why: 'Destroys file contents in place. The data cannot be recovered.',
    severity: 'high',
    pattern: /\b(?:shred|truncate)\b/g,
  },
  {
    id: 'force-push',
    label: 'git push --force',
    why: 'Overwrites remote history. Commits other clones hold can be lost.',
    severity: 'high',
    pattern: /\bgit\s+push\b[^\n;|&]*?--force(?:-with-lease)?\b/g,
  },
  {
    id: 'reset-hard',
    label: 'git reset --hard',
    why: 'Discards every uncommitted change in the working tree.',
    severity: 'high',
    pattern: /\bgit\s+reset\s+--hard\b/g,
  },
  {
    id: 'kill',
    label: 'kill',
    why: 'Terminates running processes.',
    severity: 'medium',
    pattern: /\b(?:kill|pkill|killall)\b/g,
  },
  {
    id: 'aws',
    label: 'aws',
    why: 'Reaches live cloud infrastructure with your account credentials.',
    severity: 'medium',
    pattern: /\baws\s+\S/g,
  },
  {
    id: 'open-permissions',
    label: 'chmod 777',
    why: 'Grants every user on the machine full read, write and execute access.',
    severity: 'medium',
    pattern: /\b(?:chmod|chown)\b[^\n;|&]*?777/g,
  },
  {
    id: 'service',
    label: 'system services',
    why: 'Starts, stops or re-enables a system service.',
    severity: 'medium',
    pattern:
      /\b(?:systemctl\s+(?:start|stop|restart|enable|disable)|service\s+\S+\s+(?:start|stop|restart))\b/g,
  },
]
