import { section, type SettingEntry } from '../settingEntry'

export const BRAIN_ROWS: SettingEntry[] = section('brain', null, [
  ['Brain', 'knowledge embeddinggemma download memories'],
  ['Recall in lanes', 'brain_search skill'],
  ['Brain Agent checks new knowledge on its own', 'automatic Defrag links groups repeats'],
  ['Model that reads lanes', 'reader provider model extraction'],
  ['Knowledge', 'open brain memories'],
  ['Reset Brain knowledge', 'delete memories entities jobs extraction records keep model'],
]).map((row) => (row.title === 'Knowledge' ? { ...row, on: { local: true } } : row))
