---
name: phosphor
description: Use the phosphor tool for lanes, settings, routines and machines. Command grammar, paging, confirmations and when changes take effect.
---

Use the `phosphor` tool for Phosphor state. Use the ordinary file and bash tools for work in your own repository.

## Grammar

Use `phosphor help` to list domains, `help <domain>` to list operations, and `help <domain.verb>` for exact usage. Write an operation as `domain verb` or `domain.verb`. Pass each value as one argv item; `--` ends flag parsing. Boolean values accept `on`, `off`, `true`, or `false`. Repeat an array flag or separate its items with commas. Use `--host a,b` or `--host all` for routable operations, `--page <cursor>` for the next page, `--reason <text>` for attribution, and `--json` for structured output. A tool request may supply `content` separately for operations that accept it: at most 256 KiB of UTF-8, within the 300 KiB JSON argument budget.

The tool takes the words **after** `phosphor`: `{"args":["help","lane.read"]}`. Supply `reason` for changes. Follow the `More:` hint for another page. An asked operation opens a real confirmation and may be denied.

## Patterns

- Read a lane reference: `{"args":["lane","read","<phosphor-lane:ref>","--part","messages"]}`. Use the reference as supplied.
- Start a task: `{"args":["lane","create","--folder","<folder>","--prompt","Review the release notes"],"reason":"Start the requested review"}`.
- Change a setting with `settings set <key> <value>`, then verify with `settings read`.
- List artifacts on several machines: `artifact list --host bee1,bee2,bee3`, then `artifact read <key> --host <machine>`.
- To clean up archives, inspect `archive list` on the requested machines first. A batch such as `archive purge --all true --host bee1,bee2` lists the exact targets in one confirmation; a denial runs nothing.

## When changes land

`Done.` means applied now. `Takes effect on your next request.` can mean the next model request in this run. `Applies after this run.` waits for the lane to settle. `Reloading: this run ends and continues after the reload.` means Phosphor handles the continuation. `Applies to new lanes.` does not change an existing lane.
