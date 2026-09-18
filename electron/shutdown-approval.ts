type Intent = 'quit' | 'update'
interface Checks {
  needsConfirmation: () => boolean
  confirm: (intent: Intent) => Promise<boolean>
}

/** One owner for a quit/update decision; approval closes admission atomically. */
export class ShutdownApproval {
  private owner: Intent | null = null
  private accepted = false
  private updateReady = false
  private tearingDown = false

  constructor(private readonly checks: Checks) {}

  get closing(): boolean {
    return this.accepted
  }
  get canQuit(): boolean {
    return this.accepted && (this.owner === 'quit' || this.updateReady)
  }

  async request(intent: Intent): Promise<boolean> {
    // Neither a second click nor the other intent can reuse an approval to
    // run another destructive action. An update explicitly releases quit later.
    if (this.owner !== null) return false
    this.owner = intent
    try {
      if (this.checks.needsConfirmation() && !(await this.checks.confirm(intent))) {
        this.owner = null
        return false
      }
      this.accepted = true
      return true
    } catch (error) {
      this.owner = null
      throw error
    }
  }

  allowUpdateQuit(): void {
    if (this.owner !== 'update' || !this.accepted) throw new Error('Update is not authorized')
    this.updateReady = true
  }

  beginTeardown(): void {
    if (!this.canQuit) throw new Error('Quit is not authorized')
    this.tearingDown = true
  }

  releaseFailedUpdate(): void {
    if (this.owner !== 'update' || this.tearingDown) return
    this.owner = null
    this.accepted = this.updateReady = false
  }

  assertCanStart(): void {
    if (this.closing) throw new Error('Phosphor is shutting down. New work cannot start.')
  }
}

// Installed by main before user interactions. Until then, fail closed without
// Electron imports here: RPC clients and registry creation share this boundary.
let checks: Checks = { needsConfirmation: () => true, confirm: async () => false }
export function configureShutdownApproval(value: Checks): void {
  checks = value
}
export const shutdownApproval = new ShutdownApproval({
  needsConfirmation: () => checks.needsConfirmation(),
  confirm: (intent) => checks.confirm(intent),
})
