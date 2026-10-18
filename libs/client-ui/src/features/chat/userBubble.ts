/**
 * The sent-message bubble, shared by the transcript (`UserMessage`) and the
 * pre-session echo (`StartingChat`), which must look identical so the swap
 * between them moves nothing.
 *
 * It is one constant because it used to be two copies, and the copy drifted:
 * the transcript gained `break-words` and the echo did not, so a large paste
 * with a long cookie or URL painted straight through the bubble for the whole
 * time a branch was being created.
 *
 * `break-words` is not optional, and it lives on the bubble rather than on the
 * spans inside `UserText` because `overflow-wrap` inherits: one rule covers the
 * plain text, the list items, and anything added later. Without it a pasted
 * URL or token is one unbreakable word, so `max-w-[85%]` caps the BOX while the
 * text paints through it, out of the column and into a horizontal scrollbar
 * (a scroller with `overflow-y: auto` resolves its `overflow-x` to `auto`).
 */
export const USER_BUBBLE_CLASS =
  'bg-user-bubble max-w-[85%] break-words rounded-xl px-4 py-2.5 text-lg'
