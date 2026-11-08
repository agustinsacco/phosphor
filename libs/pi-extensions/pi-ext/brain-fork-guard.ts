interface GuardApi {
  on(event: 'tool_call', handler: () => { block: true; reason: string }): void
}

export default function brainForkGuard(pi: GuardApi): void {
  pi.on('tool_call', () => ({ block: true, reason: 'Knowledge extraction has no tools.' }))
}
