/** Friendly CLI spellings; the dispatcher only sees canonical catalog names. */
export const OP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  lanes: 'lane.list',
  archives: 'archive.list',
  hosts: 'hosts.list',
  artifacts: 'artifact.list',
  changes: 'audit.list',
})

export const canonicalName = (name: string): string =>
  Object.hasOwn(OP_ALIASES, name) ? OP_ALIASES[name]! : name
