import { LOCAL_ONLY, onHost, section, type SettingEntry } from '../settingEntry'

/** Accounts: This Mac's rows, until a view every machine shares renders them. */
export const ACCOUNTS_ROWS: SettingEntry[] = [
  ...section(
    'accounts',
    null,
    [
      ['Use a plan you already pay for', 'subscription sign in login oauth'],
      ['Billed per token', 'api key credit balance'],
    ],
    LOCAL_ONLY,
  ),
]

/** The Host's Accounts panel, by the heading it renders. */
export const ACCOUNTS_HOST_HEADING: SettingEntry[] = onHost('accounts', [
  'Accounts',
  'Host providers sign in login claude codex openai',
])
