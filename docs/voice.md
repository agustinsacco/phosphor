# Voice input

Dictation into the composer with a speech model that runs on this computer.
Off by default; Settings → Voice turns it on.

## What the user sees

- **Settings → Voice** has two rows. **Voice input** turns it on, which
  downloads the model. **Model** picks Moonshine Tiny (the default, about 43 MB)
  or Moonshine Base (about 135 MB, more accurate, about twice as slow). Both
  understand English only. Below them, a status line shows download progress,
  "ready", or the failure with a **Retry** button.
- With voice on and the model ready, both composers (a session's and the
  workspace home) show a **microphone** next to Attach. Click it and talk; a red
  dot shows it is listening. Click again and the transcript is inserted at the
  caret, with a space where it would run into a neighbouring word. It is never
  sent. It goes through the same edit path as the formatting keys, so Undo
  removes it.
- A failure (microphone refused, model failed to load) is an error toast. The
  draft is not touched.
- Leaving the composer while dictating (switching session) drops the dictation.

## Model and runtime

- **Moonshine v2** (MIT), in the ONNX exports the sherpa-onnx maintainers
  publish, run by **`sherpa-onnx` 1.13.8, the WebAssembly build** (Apache-2.0).
  One package of about 4 MB compressed serves every platform, so there is no
  native module to rebuild per Electron version, per architecture, or to sign.
  It is an ordinary production dependency inside the asar.
- **Silero VAD** (MIT) cuts the audio into speech segments of at most 8
  seconds, because Moonshine v2 returns nothing at all for a segment over about
  10 seconds (`electron/voice/engine.ts`). Each segment is transcribed as soon
  as it closes, while the user is still talking, so stopping waits only for the
  last one: about 0.1 to 0.8 s.
- Measured on an Apple Silicon Mac: Tiny transcribes 4 seconds of speech in
  about 0.16 s; Base takes about twice as long. The loaded model holds about
  300 to 550 MB.

## The download

- It happens only when voice is turned on, or for a different model. Each file
  is fetched by itself from a pinned location (`electron/voice/manifest.ts`):
  Hugging Face at a fixed commit, and Silero from the sherpa-onnx GitHub
  release. Each streams to its own `.part` file and is renamed into place only
  when its size and SHA-256 match. Anything else deletes the partial file and
  shows the error with Retry (`electron/voice/download.ts`).
- Files live in `<userData>/voice/`. Exactly the selected model is kept:
  switching downloads the new model, then deletes the old one; turning voice
  off deletes everything. A download interrupted by quitting resumes on the next
  launch, keeping the files that had finished.
- The model is not bundled. Every update replaces the whole app, so a bundled
  model would be downloaded again with every release.

## Processes

```
renderer: getUserMedia → AudioContext (16 kHz) → AudioWorklet (pcmWorklet.ts)
    │ 100 ms Float32 chunks, voice:audio
main: VoiceService (electron/voice/service.ts)
    │ utilityProcess messages (protocol.ts)
voice-worker.js (worker.ts): Silero VAD → Moonshine → text, returned by voice:stop
```

- The worklet runs on the audio thread, so a busy renderer does not drop
  audio. It is bundled with Vite's `?worker&url` as a script on the app's own
  origin, which the CSP allows. Nothing is played back.
- The recognizer runs in a **utility process** that starts with the first
  dictation, not at launch. It exits after 3 minutes without a dictation, and at
  once when voice is turned off or the model changes. A crash fails only the
  dictation in progress; the next one starts a new process. It is built as a
  second entry of the main bundle (`out/main/voice-worker.js`).
- `voice:start` returns before the model has loaded. Audio queues in the worker
  behind the load, so the first words of a cold start are kept.
- One dictation at a time, owned by the window that started it. Audio or a stop
  from another window is ignored, closing the window cancels it, and a new start
  cancels the one before. Main drops any chunk over 5 seconds.

## Privacy and permissions

- Audio is never written to disk and never leaves the machine. The model
  download is the only network use.
- **macOS:** `NSMicrophoneUsageDescription` is in the app's `Info.plist`
  (`electron-builder.yml`); without it macOS terminates the app when it opens
  the microphone. The `com.apple.security.device.audio-input` entitlement covers
  builds signed with the hardened runtime. Main asks for the microphone through
  `systemPreferences` on the first dictation; when it is refused, the dictation
  fails with a pointer to the system privacy settings.
- **Windows** honours the system microphone switch, read through the same API.
  **Linux** has no OS gate to ask.
- **Chromium permissions** (`electron/voice/permissions.ts`): a media request
  is granted only for audio and only for the app's top-level page. Artifact and
  preview iframes never get the microphone. Every other permission keeps
  Electron's default, which grants it.

## Contract

- Prefs: `AppPrefs.voice` (`{ enabled, model }`, `libs/shared/src/voice.ts`),
  normalized on read and write.
- IPC: `voice:status`, `voice:setPrefs`, `voice:start`, `voice:audio`,
  `voice:stop` and `voice:cancel`, plus the `voice:statusChanged` push
  (`libs/shared/src/ipc/services.ts`). The renderer's projection is `stores/voice.ts`.

## Tests

- Unit tests sit beside each module in `electron/voice/` (verified download,
  the service with a fake worker, segmenting, manifest drift, permissions), and
  `features/voice/insertDictation.test.ts` covers the text placement.
- `engine.test.ts` runs the real model and is opt-in, because it downloads
  Tiny (cached in the temp directory):
  `PHOSPHOR_VOICE_INTEGRATION=1 npx vitest run apps/desktop/electron/voice/engine.test.ts`.
- There is no e2e spec: CI has no microphone, and the suite does not download
  models.
