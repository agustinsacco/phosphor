import { test } from '@playwright/test'

test.fixme('Browse, add and remove folders on bee1 (phase 2)', async () => {
  // no open lane, Files lists configured repositories and read-only preview; Add folder browser has
  // home breadcrumbs/repo badges, adds git or non-git directory, list/home chip updates. Remove
  // asks confirmation and files-kept copy; confirm hides config entry, does not delete disk. Live-
  // lane folder removal refuses visibly; disabled policy hides/disables Add with reason. Symlink
  // escape refuses. Capture folder modal/machine Files in both themes.
})

test.fixme('Remote artifacts and Skills are useful read-only pages (phase 2)', async () => {
  // generate artifact then inspect pane title/version/content and global bee1 library; Skills opens
  // Host SKILL.md, provider/model list excludes Mac markers, mutation controls absent. Artifact
  // workspace write/open fixed-disabled; download/PDF explicit This Mac and produces expected file;
  // sandbox remains usable.
})

test.fixme('Remote routine creation uses Host models and reports history (phase 2)', async () => {
  // select bee1, create routine with Host repo/model, explicit unattended enable, run, assert
  // running→completed history and machine label; cancel second slow run. Output Open only if real
  // lane identity exists, otherwise fixed unavailable reason. Change new-editor target and verify
  // incompatible model cleared/revalidated; no local catalogue fallback.
})
