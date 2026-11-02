import { section, type SettingEntry } from '../settingEntry'

/** Voice: This Mac's section only. */
export const VOICE_ROWS: SettingEntry[] = section('voice', null, [
  ['Voice input', 'dictation dictate microphone mic speech to text transcribe'],
  ['Model', 'moonshine speech download'],
])
