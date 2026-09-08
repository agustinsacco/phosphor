# The home composer and the session composer had drifted

The two composers share most of their parts already: `ComposerField`,
`AttachmentChips`, `DropOverlay`, `useAttachments`, `AttachButton`,
`SubmitIconButton`, `composePrompt` / `toImageContents`, `ModelMenu`,
`ThinkingMenu`. What they did **not** share was the model/thinking chip, and
that is where they drifted.

## What was wrong

Putting the provider on the model's own line
([#206](https://github.com/agustinsacco/Phosphor/pull/206)) reached
`ModelPicker` and not `HomeModelPicker`, because the chip markup was
copy-pasted between them. So a live session read

    Claude Opus 5  pi-claude-cli

and the home screen still read

    Claude Opus 5
    via pi-claude-cli

The drift went the other way too, and predates that PR: `ModelPicker` named
the provider only when pi does not ship it (`NATIVE_PROVIDERS`), while
`HomeModelPicker` named it for **every** model. A plain `anthropic` model on
the home screen carried a second line saying `via anthropic` — a line that
tells you nothing, in the one place where vertical space is least contested.

Three smaller divergences came with it:

|                        | home                                 | session                   |
| ---------------------- | ------------------------------------ | ------------------------- |
| `ComposerField` class  | duplicated 13-token string, `pt-3.5` | component default, `pt-3` |
| picker wrapper gap     | `gap-0.5`                            | `gap-1`                   |
| footer right-group gap | `gap-0.5`                            | `gap-1.5`                 |

The class string is the interesting one: the home call site restated
`ComposerField`'s entire default `className` in order to change one padding
value, which makes every future change to that default silently skip home.

## What changed

`src/features/chat/composer/ModelChip.tsx` now owns the chrome: the button,
the one-line name/provider row, the loading pulse, the tone/active states, and
`NATIVE_PROVIDERS`. Both pickers render it.

The **data** split stays exactly as it was, because it is not duplication.
`ModelPicker` drives a live pi process over RPC (`set_model`, then re-reads
`get_state` for the level pi clamped to); `HomeModelPicker` has no process to
talk to, so it reads and writes pi's own defaults in `settings.json`. Those
are different behaviours with different failure modes. The comment in
`HomeModelPicker` explaining why has been there since it was written, and it
is still right.

`name` is a `ReactNode` rather than a string so home can keep its own warning
suffixes (`· unavailable`, `· pi unreachable`) without the chip knowing about
the model catalogue.

## Verification

`ModelChip.test.tsx` — 8 tests, and they are the guard that matters: the
native-provider gate in both directions, the provider on the same line and not
as a block, the shrink priority, the warning suffix, the disabled-while-loading
state.

Measured live against the pi stub at 1440×900, after picking the
`pi-claude-cli` route for Claude Opus 5:

|                               | before           | after                     |
| ----------------------------- | ---------------- | ------------------------- |
| home chip height              | 48px (two lines) | **32px**                  |
| home provider baseline offset | one full line    | **2.5px**                 |
| home card height              | 102px            | **100px**                 |
| home textarea `padding-top`   | 14px             | 12px (the shared default) |

The 2px is the dropped `pt-3.5` override. It is a real, deliberate visual
change: keeping it meant keeping the duplicated class string.

## Still different, on purpose — and one open question

The home composer keeps `rows={2}` (a first prompt is usually longer than a
follow-up) and has no context meter, queue chips, steering row or `!cmd` hint,
because none of those exist before a session does.

One difference is **not** yet resolved: the cards clamp to different widths —
home `max-w-2xl` (672px), session `max-w-3xl` (768px). That is a design call,
not an accident of duplication, so it is left alone here.
