# Review

The delivery note for the three films as rendered. Read it before changing them.

## Calls made

- **One layout for all three.** Copy column left, real app window right, bleeding off the frame.
  The films are tutorials first, so the product holds one framing while the copy is read.
- **Four steps each**, matching the written walkthrough beside the video; the rail shows which.
- **Captures swap in place.** A press of the cursor is followed, on the same frame, by the next
  real capture. Between unrelated moments the window's contents whip instead, so a cut is never
  passed off as an interaction.
- **Fix and Address are outlined, not pressed.** There is no capture of the drafted prompt, and
  the film does not invent one.
- **Silent**, by the site's contract. `hyperframes check` warns `film_silent` on each film; that
  is the one warning kept on purpose.

## Measured

- `hyperframes check` on each film: lint, runtime, layout, contrast and craft with no error and
  no other warning. Contrast passed at every sampled text element.
- `scripts/build-films.mjs verify`: codec, pixel format, size, frame rate, no audio stream,
  duration against `films.json`, `moov` before `mdat`, poster size. Results are in `media.json`.
- `scripts/films.test.mjs`: scenes tile each film, every product scene carries the slate, the
  captures used are the ones listed, no remote reference besides the pinned GSAP build.

## Looked at

Stills at each scene's start, middle and seam, and a contact sheet of every encoded film at one
frame per 1.5 s. Checked for: copy matching the storyboard, outlines sitting on the control they
name, the cursor not covering a label being read, nothing illustrative (spend, tokens) framed as
the subject.

## Not checked

- Playback in the site page and in Safari; the films were not watched in a browser player.
- Motion was judged from stills and contact sheets, not at full speed by a person.
- Phone-width legibility of the interface text. Titles and supporting lines are sized for it;
  small interface text inside a capture is not readable at 360 px wide and is not meant to carry
  the message.

## Weakest shots, and what would fix them

- **Push-ins are soft.** Captures are at 1×. The What changed panel in particular is a 384×225
  crop, shown at 2× to keep the read and Undo legible. Captures
  taken at device scale 2 (same layout, so the rectangles hold) would make every push-in sharp
  with no change to the films.
- **`enable` (brain-walkthrough, 0-4.6 s).** The settings dialog is mostly empty until the
  switch is pressed, and its body text is small at this size.
- **`hosts` (overview).** The phone covers the Machines list's status column once it rises.
- **`inspect` (overview).** The artifact pane arrives during a camera move rather than from a
  press, the one place a capture changes without a visible cause.
- **Lane state differs between captures.** `chat` and `lane-pr` have no Slack message or pill;
  `changes`, `slack-pill` and `notifications` do. The film whips between those moments rather
  than pretending they are continuous. One conversation state across all lane captures would
  allow a single unbroken take.
