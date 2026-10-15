import { test } from '@playwright/test'

test.fixme('Create on bee1 with a usable default and name the first turn (phase 2)', async () => {
  // select bee1; open New lane; assert Host repository, effective signed-in provider/model and
  // thinking, no LOCAL_ONLY option; create; submit first prompt; assert one user/reply, immediate
  // first-prompt title then short generated title, human repo+bee1 header and no hex/Untitled.
  // Manual rename before delayed naming must remain. Capture dialog/header/inline rename.
})

test.fixme('Home composer sends only after controlled remote creation (phase 2)', async () => {
  // choose Host folder/model/thinking; send draft; assert remote lane and single first turn,
  // cleared composer after success. Inject create/send refusal; assert fixed alert, retained draft
  // and no local lane.
})

test.fixme('Remote row menu is complete, gated and durable (phase 2)', async () => {
  // right-click and keyboard-open; Open, Rename, Pin/Unpin, marker, Mark read, Copy debug, Copy
  // spend; assert row/name/badge/pin after reopen and relaunch, clipboard contains bee1 but no
  // paths/keys. Assert unavailable local tree/fork/clone/Make routine absent; if Export shipped,
  // open output and check transcript. Take/Release/Stop/Resume/Delete presence checked here,
  // execution below. Capture menu and marker.
})
