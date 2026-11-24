import { configure, domain } from './spec'

// Help-only names. No schema accepts a credential, an OAuth code or a trust acknowledgement.
// allowOps is reserved too, not a writable field on a routine definition or patch.
const reserved = domain('machine', configure, { routable: false })
const names = [
  ['account.signIn', 'Sign in to Phosphor.'],
  ['account.signOut', 'Sign out of Phosphor.'],
  ['provider.login', 'Sign in to a provider.'],
  ['provider.logout', 'Sign out of a provider.'],
  ['claude.login', 'Sign in to Claude.'],
  ['claude.logout', 'Sign out of Claude.'],
  ['claude.addAccount', 'Add a Claude account.'],
  ['claude.removeAccount', 'Remove a Claude account.'],
  ['mcp.login', 'Authorize an MCP server.'],
  ['mcp.logout', 'Sign out of an MCP server.'],
  ['machine.enroll', 'Enroll the Phosphor service.'],
  ['control.machines', 'Read the enrollment directory.'],
  ['control.lookupEnrollment', 'Look up an enrollment.'],
  ['control.approveEnrollment', 'Approve a machine enrollment.'],
  ['control.renameMachine', 'Rename an enrolled machine.'],
  ['control.removeMachine', 'Remove an enrolled machine.'],
  ['grant.issue', 'Issue a machine grant.'],
  ['hosts.settingsAccess', 'Grant settings access.'],
  ['agentControl.set', 'Change the agent kill switch.'],
  ['routine.trust', 'Acknowledge unattended routine access.'],
  ['routine.allowOps', 'Change a routine’s allowed operations.'],
  ['folder.trust', 'Trust a folder.'],
  ['webAccess.key', 'Change a web access credential.'],
  ['brain.review', 'Review Brain knowledge.'],
  ['brain.tidy', 'Tidy Brain knowledge.'],
  ['brain.merge', 'Merge Brain knowledge.'],
  ['brain.forget', 'Forget Brain knowledge.'],
  ['brain.reset', 'Reset Brain knowledge.'],
] as const
export const neverOps = names.map(([name, summary]) => reserved(name, summary, 'never'))
