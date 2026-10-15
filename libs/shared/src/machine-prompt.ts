export type MachineContext =
  | { kind: 'host'; label: string; os: string; repositories: readonly string[] }
  | { kind: 'desktop'; signedIn: boolean }

// Local display names are data, not prompt markup. Bound the total list as well
// as each name so a large repository catalogue cannot dominate every request.
function printable(value: string, limit: number): string {
  return value
    .replace(/[^\x20-\x7e]|[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function machinePromptBlock(machine: MachineContext | undefined): string | undefined {
  if (!machine || (machine.kind === 'desktop' && !machine.signedIn)) return undefined
  if (machine.kind === 'desktop') {
    return [
      '<phosphor_machine>',
      "You are running on the user's own computer, where Phosphor's window is.",
      '</phosphor_machine>',
    ].join('\n')
  }
  const names: string[] = []
  for (const name of machine.repositories.slice(0, 20)) {
    const clean = printable(name, 24) || 'unnamed'
    if ([...names, clean].join(', ').length > 96) break
    names.push(clean)
  }
  const remaining = machine.repositories.length - names.length
  const repositories = [...names, ...(remaining ? [`and ${remaining} more`] : [])].join(', ')
  return [
    '<phosphor_machine>',
    `You are running on ${printable(machine.label, 24) || 'this machine'} (${printable(machine.os, 12)}), a Phosphor Host. The user drives this lane from Phosphor on another computer over their private Tailscale network; they do not see this machine's screen.`,
    '- phosphor status and phosphor doctor are safe to run here.',
    '- Do not use SSH or other remote shells to start, drive or message Phosphor agents on other machines.',
    '- Do not stop, restart, update, log out or reconfigure the Phosphor Host service, and do not edit its config folder: this lane runs inside it and would cut itself off.',
    ...(repositories ? [`- Repositories on this machine: ${repositories}.`] : []),
    '</phosphor_machine>',
  ].join('\n')
}
