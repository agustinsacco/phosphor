# Mermaid recipes

Use fenced `mermaid` inside Markdown, or raw Mermaid as a `mermaid` artifact.
Phosphor supplies theming and a zoom/pan viewer. Mermaid is NOT automatically
available inside an HTML artifact; use Markdown or pre-rendered inline SVG
there, never a CDN script.

Choose one question per diagram. Keep labels short, quote punctuation-heavy
labels, and split a large topology into overview and detail. Prefer top-to-bottom
for narrow panels. State which boundaries are process, machine or trust boundaries.
Distinguish planned paths in labels and/or dashed edges, not color alone.

## Architecture: ownership and boundaries

```mermaid
flowchart TB
  UI["Desktop UI"] -->|"local IPC"| Desktop
  subgraph Desktop["Desktop process"]
    Adapter["Desktop adapter"] --> Local["Shared session library"]
  end
  Local --> PiLocal["Local pi process"]
  UI -. "planned private API" .-> Host
  subgraph Host["Remote machine: planned Host"]
    API["Host API"] --> Remote["Same session library"]
  end
  Remote --> PiRemote["Remote pi process"]
```

Text alternative: local requests stay inside Desktop's local path; the proposed
remote path uses a second deployment of the same library on another machine.

## Sequence: order and failures

```mermaid
sequenceDiagram
  participant Client
  participant Host
  participant Engine as pi
  Client->>Host: Start lane (request ID)
  Host->>Host: Validate access and deduplicate
  alt Request accepted
    Host->>Engine: Start session
    Engine-->>Host: Session ready
    Host-->>Client: Session ID and events
  else Request refused
    Host-->>Client: Explicit error (no session started)
  end
```

## States: legal transitions

```mermaid
stateDiagram-v2
  [*] --> Ready
  Ready --> Running: prompt
  Running --> Ready: completed
  Running --> Stopping: cancel
  Stopping --> Ready: stopped
  Running --> Failed: process exit
  Failed --> Ready: explicit restart
```

For delivery plans use a flowchart with dependency arrows and explicit labels
such as `Done`, `In progress`, `Blocked`. Do not imply a timeline with fabricated
dates. Check every arrow against the actual dependency or transition contract.
