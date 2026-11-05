import { section, type SettingEntry } from '../settingEntry'

/**
 * Accounts. Other providers is a Host's only: This Mac's providers all come
 * from the shared catalogue, so each is a plan or billed per token.
 */
export const ACCOUNTS_ROWS: SettingEntry[] = [
  ...section('accounts', null, [
    ['Use a plan you already pay for', 'subscription sign in login oauth'],
    ['Billed per token', 'api key credit balance'],
  ]),
  ...section('accounts', null, [['Other providers', 'api key default provider']], { host: true }),
  ...section('accounts', null, [['Claude Code', 'claude accounts routing']]),
]
