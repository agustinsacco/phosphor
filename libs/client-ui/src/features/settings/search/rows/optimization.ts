import { section, type SettingEntry } from '../settingEntry'

/** Optimization: This Mac's section only. */
export const OPTIMIZATION_ROWS: SettingEntry[] = [
  ...section('optimization', null, [
    ['Compress tool results', 'headroom proxy tokens'],
    ['Compress search & log output', 'headroom grep'],
  ]),
  ...section('optimization', ['Savings', 'tokens saved']),
  ...section('optimization', ['Advisor', 'recommendations findings']),
]
