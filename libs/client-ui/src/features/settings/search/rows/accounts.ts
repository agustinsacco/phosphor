import { section, type SettingEntry } from '../settingEntry'

/** Accounts: the same rows on every machine. */
export const ACCOUNTS_ROWS: SettingEntry[] = section('accounts', null, [
  ['Use a plan you already pay for', 'subscription sign in login oauth'],
  ['Billed per token', 'api key credit balance'],
  ['Other providers', 'api key default provider'],
  ['Claude Code', 'claude accounts routing'],
])
