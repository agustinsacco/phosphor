# Spec

The brief the three films are built from. Numbers, not adjectives.

```text
GOAL     A developer sees the real interface doing one thing per beat and can repeat it.
OUTPUT   Hyperframes 0.9.49, 1280 x 720, 30 fps, H.264 yuv420p, silent, CRF 19.
LOOK     Phosphor's dark theme (docs/style-guide.md), no second palette.
         Ground #15130f. App window #1e1c18 with a 1 px #4b453a edge and a 14 px top-left
         radius, bleeding 40 px off the right and bottom edges so the product is cropped, not
         floating. Ink #ece7db, quiet ink #aca496. Amber #eca03d on one word per title, the
         current rail step and outlines; nowhere else.
         Title: Inter 500, 47 px (6.5% of height), tracking -0.047em, at most three lines.
         Supporting line: Inter 400, 21 px. Step label: JetBrains Mono 500, 19 px.
         Fonts are the site's own files. No gradients, glow, grain or glass.
GRID     Copy column x 56-432. Window x 460-1280, y 52-720 (820 x 668 visible).
OBJECTS  The app window (a real capture). The four-step rail, shaped like the product's own
         Opened / Checks / Review / Merge rail. A 30 px arrow cursor. A 2 px amber outline with
         a 4 px soft edge around a real control. The beacon mark, from the site's favicon file.
MOTION   Camera: power2.inOut, 0.9-1.4 s, one move per beat, then a hold while copy is read.
         Title: per word, blur 7 px to 0 and opacity 0 to 1 in 0.24 s, 0.07 s apart, no travel.
         Supporting line: whole line, 0.3 s. Exits: blur and fade in 0.2 s.
         Cursor: power3.inOut 0.7-1.2 s; press dips to 0.8 over 0.07 s, and the next capture
         appears on that frame in 0.1 s. Outline: scale 1.12 to 1 in 0.34 s, power3.out.
         Whip between moments: 110 px, 14 px blur, 0.22 s out (power3.in), 0.42 s in (expo.out).
         End card: mark on back.out(1.5) 0.8 s, wordmark wipe 0.5 s, headline per word.
READING  A line holds 0.5 s + 0.3 s a word; the last line of a film at least 2 s.
BANNED   Drawn or retouched interface. A title over a dimmed screenshot. A window floating
         small in a void. Glow, particles, gradients. Titles that drift after landing. Click
         rings. Three cards in a row. The logo docked in a corner. Any number the product did
         not show; any speed, quality or completion claim; the illustrative spend and token
         totals on Home as a subject.
QA       hyperframes check with no finding except film_silent. Stills at every scene's start,
         middle and seam. ffprobe of the shipped files. A contact sheet of the encoded film.
```

## Why these choices

- **One window, one camera.** The films swap real captures in place where the interface would
  change, so the product's own navigation carries the story instead of slides.
- **Copy beside the product, never on it.** The interface stays fully legible and nothing the
  film says can be mistaken for something the app displayed.
- **The slate stays on screen.** A frame taken out of the film still says the data is fictional.
- **Silent.** The page plays these with native controls and a written walkthrough; a soundtrack
  would add a licence and nothing a reader needs.
