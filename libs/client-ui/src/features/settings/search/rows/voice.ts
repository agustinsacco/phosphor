import { section, type SettingEntry } from '../settingEntry'

/** Voice: this device's dictation, wherever it can run a local speech model. */
export const VOICE_ROWS: SettingEntry[] = section('voice', null, [
  ['Voice input', 'dictation dictate microphone mic speech to text transcribe'],
  ['Model', 'moonshine speech download'],
])
