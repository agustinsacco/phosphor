# Readable, keyboard-operable diffs

Changes rows now expose separate native Open/Revert buttons instead of making a
non-focusable div clickable. Opening a diff focuses Back; returning focuses its
original row. No restore/inventory logic changed and Revert gained no prominence.

`MonacoDiff` no longer hardcodes 12 px / JetBrains Mono. Both Monaco surfaces share
one preference mapping, read current values at async initialization and update
live. Appearance copy now matches this behavior; existing saved values remain.
The Electron regression walks open/back by keyboard, checks no revert dialog or
file mutation, and changes font preferences on an already-open diff and a remount.
