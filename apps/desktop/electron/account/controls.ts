import type { AccountView } from '@shared/account'
import type { Account, AccountState } from './account'

export interface ControlPorts {
  account(): Account
  view(state: AccountState): AccountView
}

export function createAccountControls(ports: ControlPorts): {
  snapshot(): AccountView
  signIn(): AccountView
} {
  const snapshot = (): AccountView => ports.view(ports.account().state())
  return {
    snapshot,
    signIn() {
      void ports.account().signIn()
      return snapshot()
    },
  }
}
