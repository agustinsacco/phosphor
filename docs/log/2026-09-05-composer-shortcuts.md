# Work-area shortcuts and streaming input

F6 moves between composer and pane controls; fullscreen exposes its exit rather
than focusing hidden chat. New/file-finder/Files/Changes shortcuts work from the
composer while ordinary editor input, IME/AltGr and dialogs are protected. Legacy
portal markers scope shortcuts, not a new focus trap. Terminal refits and search
activation respect focus moved by the user. Formatting and palette shortcuts keep separate chords.

Steer now / Queue follow-up expose existing running-turn modes. Empty drafts
disable them without moving controls; sending returns focus to the input.
Alt, Cmd or Ctrl+Enter consistently chooses follow-up. The stub holds a turn and
records real RPC commands to verify modes without claiming to execute pi's queue.
Validation includes editor/terminal focus, dialog guards, saved drafts and wire
mode checks. The disappearing action row exposed a viewport-growth scroll clamp;
a CSS-relative reader floor fixes it without loosening the existing regression.
No provider, session recovery or artifact policy was changed.
