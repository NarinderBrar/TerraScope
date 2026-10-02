# TerraScope Timeline Progressive Loading Plan

## Goal

Improve TerraScope Timeline so satellite imagery loads in a predictable
temporal order and tiles progressively resolve instead of appearing
abruptly.

This first implementation should **not change the EOT1 binary format**
and should **not stream partial rows of a single tile**. TerraScope
already supports parent-tile fallback, so use that mechanism first.

## Current Architecture

Current render path:

``` text
Timeline / Scene selection
        ↓
MapScene.setScene(scene)
        ↓
visibleTiles(camera, viewport)
        ↓
MapScene.#ensure(...)
        ↓
RasterClient.tile(...)
        ↓
Python raster service
        ↓
COG read + calibration + reprojection/resampling
        ↓
EOT1 numeric tile
        ↓
Browser NumericTile
        ↓
NDVI compute + RasterRenderer upload
        ↓
WebGPU
        ↓
Canvas
```

Relevant frontend files:

``` text
apps/web/src/App.tsx
apps/web/src/app/MapScene.ts
apps/web/src/data/RasterClient.ts
apps/web/src/gpu/RasterRenderer.ts
apps/web/src/gpu/shaders/tile.wgsl
apps/web/src/map/MapCamera.ts
```

The current `MapScene` already requests a parent tile and uses it as a
fallback while the exact child tile is unavailable.

------------------------------------------------------------------------

# Part 1 --- Deterministic Timeline Ordering

## Problem

Scene search results may not arrive or display in the temporal order
expected by Timeline.

Tile/network requests also finish asynchronously, so completion order
can appear random.

## Requirement

Normalize scene order after every search.

Default order:

``` text
oldest → newest
```

Example:

``` text
2024-06-01
2024-06-06
2024-06-11
2024-06-16
2024-06-21
```

Do not depend on STAC/server result order.

## Implementation

In `App.tsx`, normalize scenes before storing them:

``` ts
function sortScenesByDate(scenes: Scene[]): Scene[] {
  return [...scenes].sort(
    (a, b) =>
      new Date(a.datetime).getTime() -
      new Date(b.datetime).getTime(),
  );
}
```

When paginated results are merged:

``` text
previous scenes
      +
new scenes
      ↓
deduplicate by scene.id
      ↓
sort by datetime
      ↓
store
```

Do not mutate the response array directly.

## Acceptance

Given scenes returned as:

``` text
Jun 21
Jun 01
Jun 16
Jun 06
```

Timeline must display:

``` text
Jun 01
Jun 06
Jun 16
Jun 21
```

------------------------------------------------------------------------

# Part 2 --- Timeline-Aware Prefetching

## Goal

When the user is viewing one acquisition, start preparing nearby dates
before they move the timeline.

Example:

``` text
Jun 01 ─ Jun 06 ─ Jun 11 ─ Jun 16 ─ Jun 21
                   ▲
                 current
```

Priority:

``` text
Jun 11    current       highest
Jun 16    next          high
Jun 21    next + 1      medium
Jun 06    previous      medium
Jun 01    distant       low
```

For forward playback, prioritize future scenes.

For backward playback, reverse the direction.

## Important

Do **not** download every tile for every date.

Only prefetch:

-   currently visible map area
-   current zoom / useful parent zoom
-   a small number of neighboring dates

Suggested initial window:

``` text
current
next
next + 1
previous
```

------------------------------------------------------------------------

# Part 3 --- Tile Request Scheduler

## Problem

`MapScene.#ensure()` currently starts a request immediately.

This means all visible requests compete equally.

## Change

Introduce a bounded priority queue.

Suggested new module:

``` text
apps/web/src/map/TileRequestScheduler.ts
```

Conceptual API:

``` ts
interface TileRequest {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<void>;
}

class TileRequestScheduler {
  enqueue(request: TileRequest): void;
  cancel(key: string): void;
  cancelExcept(keys: ReadonlySet<string>): void;
  clear(): void;
}
```

## Concurrency

Start with:

``` text
MAX_CONCURRENT_TILE_REQUESTS = 6
```

Make it a constant so it can be profiled later.

Do not make date loading strictly serial. We want deterministic
**priority**, not one-request-at-a-time networking.

------------------------------------------------------------------------

# Part 4 --- Spatial Tile Priority

For each date, load the most useful tiles first.

Priority should consider:

1.  Parent fallback
2.  Distance from viewport center
3.  Exact-resolution child tile

Recommended strategy:

``` text
Parent tiles near center
        ↓
Parent tiles around viewport
        ↓
Exact tiles near center
        ↓
Exact tiles around viewport
```

This gives the user useful imagery quickly.

## Center Distance

For each visible tile calculate approximately:

``` ts
const dx = tileCenterX - viewportCenterX;
const dy = tileCenterY - viewportCenterY;
const distance = Math.sqrt(dx * dx + dy * dy);
```

Smaller distance = higher priority.

Avoid expensive calculations if squared distance is sufficient.

------------------------------------------------------------------------

# Part 5 --- Progressive Parent → Exact Rendering

TerraScope already supports:

``` text
exact tile missing
        ↓
find parent
        ↓
render correct quadrant of parent texture
```

Keep this architecture.

Desired visual sequence:

``` text
blank
  ↓
parent / lower-resolution imagery
  ↓
exact tile arrives
  ↓
high-resolution imagery
```

This is the first version of "tile streaming."

Do not modify EOT1 yet.

------------------------------------------------------------------------

# Part 6 --- Optional WebGPU Crossfade

After the scheduler works correctly, add a short transition when
replacing parent imagery with an exact tile.

Target:

``` text
100% parent / 0% child
        ↓
70% parent / 30% child
        ↓
40% parent / 60% child
        ↓
0% parent / 100% child
```

Suggested duration:

``` text
120–200 ms
```

This is visual polish, not a requirement for the scheduler.

Do not delay displaying a child tile just to perform the animation.

## Possible RenderTile State

``` ts
interface TileTransition {
  startedAt: number;
  durationMs: number;
}
```

The renderer can derive:

``` ts
progress = clamp(
  (performance.now() - startedAt) / durationMs,
  0,
  1
);
```

If implementing this requires major bind-group/shader restructuring,
leave it for a second commit.

------------------------------------------------------------------------

# Part 7 --- Timeline Playback Strategy

For playback:

``` text
DISPLAY       PREFETCH       QUEUED

Jun 11        Jun 16         Jun 21
████████      █████░░░       ██░░░░░
```

When advancing:

``` text
DISPLAY       PREFETCH       QUEUED

Jun 16        Jun 21         Jun 26
████████      █████░░░       ██░░░░░
```

Do not advance automatically to a date that has zero usable imagery if
playback can wait briefly for its parent/center tiles.

However, avoid long blocking behavior. Playback responsiveness is more
important than waiting for a completely loaded scene.

------------------------------------------------------------------------

# Part 8 --- Priority Model

Use a simple numerical score.

Lower score = higher priority.

Example:

``` text
priority =
    datePriority * 10000
  + resolutionPriority * 1000
  + distanceFromCenter
```

Example date priorities:

``` text
current      0
next         1
previous     2
next + 1     3
other        10+
```

Example resolution priorities:

``` text
parent       0
exact        1
```

This gives:

``` text
current parent
current exact
next parent
next exact
previous parent
...
```

Tune only after profiling.

------------------------------------------------------------------------

# Part 9 --- Cancellation

Cancellation is critical.

When the user:

-   pans far away
-   zooms
-   selects another scene
-   jumps to another timeline date
-   changes quality-mask settings

obsolete requests must be cancelled.

The current `AbortController` behavior should be preserved.

Scheduler should support:

``` text
wanted tile keys
        ↓
cancel queued requests not wanted
        ↓
abort active requests not wanted
```

An aborted request must never upload its result to WebGPU.

Keep the existing race protection.

------------------------------------------------------------------------

# Part 10 --- Cache / Residency

Do not clear useful prefetched dates unnecessarily.

Current `setScene()` clears all GPU tiles because tile bytes are
date-specific.

For timeline prefetching, eventually move toward date-aware residency:

``` text
GPU Cache

Date N-1
Date N
Date N+1
```

But keep memory bounded.

The current GPU tile estimate is large, so do not blindly retain several
complete dates.

Initial implementation can prioritize network/browser caching and parent
tiles without retaining every prefetched date on GPU.

A later optimization can introduce:

``` text
TimelineTileCache
```

with limits based on:

``` text
date
tile count
GPU bytes
last-used time
```

------------------------------------------------------------------------

# Part 11 --- Do Not Implement Yet: Partial EOT1 Streaming

Do NOT start with:

``` text
EOT1 header
↓
rows 0–31
↓
GPU upload
↓
rows 32–63
↓
GPU upload
...
```

Although technically possible, this requires changes to:

-   Python response streaming
-   EOT1 framing
-   browser incremental decoder
-   error recovery
-   partial validity masks
-   partial GPU texture writes
-   caching semantics

First measure the experience after:

``` text
date-aware scheduling
+
parent-first loading
+
center-first loading
+
bounded concurrency
+
optional crossfade
```

Only add partial EOT1 streaming if profiling proves it is necessary.

------------------------------------------------------------------------

# Part 12 --- Suggested Implementation Order

## Commit 1 --- Timeline ordering

Implement:

-   date sort
-   pagination merge
-   scene deduplication
-   tests

Commit message:

``` text
feat(timeline): order scenes deterministically by acquisition date
```

## Commit 2 --- Priority scheduler

Implement:

``` text
TileRequestScheduler
bounded concurrency
priority queue
cancellation
```

Commit message:

``` text
feat(map): add prioritized tile request scheduler
```

## Commit 3 --- Parent-first / center-first loading

Update `MapScene` request generation.

Implement:

``` text
parent priority
viewport-center priority
exact child priority
```

Commit message:

``` text
feat(map): prioritize progressive viewport tile loading
```

## Commit 4 --- Timeline prefetch

Implement nearby-date scheduling.

Commit message:

``` text
feat(timeline): prefetch adjacent acquisitions
```

## Commit 5 --- Optional WebGPU transition

Only if straightforward after previous commits.

Commit message:

``` text
feat(renderer): crossfade parent tiles into exact resolution
```

------------------------------------------------------------------------

# Part 13 --- Tests

Add unit tests for the scheduler.

## Ordering

Input:

``` text
C priority 30
A priority 10
B priority 20
```

Expected start order:

``` text
A
B
C
```

## Concurrency

If max concurrency = 3:

``` text
active requests <= 3
```

at all times.

## Cancellation

Queue:

``` text
A
B
C
```

Change viewport so only C is wanted.

Expected:

``` text
A cancelled
B cancelled
C retained
```

## Date ordering

Unsorted scenes must become chronological.

## Deduplication

Same scene returned by adjacent STAC pages must occur once.

## Parent fallback

If exact tile is missing but parent is resident:

``` text
renderer receives parent key + child quadrant UV
```

When exact tile becomes resident:

``` text
renderer switches to exact tile
```

------------------------------------------------------------------------

# Part 14 --- Performance Instrumentation

Keep existing metrics:

``` text
requests
downloadedBytes
decodeMs
cacheHits
resident
pending
failed
lastFrameMs
```

Add if useful:

``` text
queued
active
cancelled
prefetched
parentFallbacks
exactTiles
```

This will tell us whether the new behavior actually improves loading
rather than only looking different.

------------------------------------------------------------------------

# Acceptance Criteria

The implementation is complete when:

1.  Search results always appear chronologically.
2.  Timeline requests prioritize the current and nearby dates.
3.  Network requests remain parallel but bounded.
4.  Center-of-screen imagery becomes useful before peripheral imagery.
5.  Parent tiles appear before exact-resolution children when available.
6.  Exact tiles replace parents progressively without blank flashes.
7.  Moving the map/date cancels obsolete work.
8.  Old responses cannot upload after cancellation.
9.  Existing natural-colour, false-colour, NDVI, band, swipe and
    difference modes continue to work.
10. Existing EOT1 format and Python tile API remain compatible.
11. No unbounded GPU/network cache is introduced.
12. Tests cover sorting, scheduling, concurrency and cancellation.

------------------------------------------------------------------------

# Implementation Status

Implemented on the current branch:

- chronological, non-mutating scene normalization with page deduplication
- a six-request priority scheduler with cancellation and race protection
- parent-first, center-first, exact-resolution viewport request scoring
- direction-aware `current`, `next`, `next + 1`, `previous` frame prefetch
- cancellation when the viewport, date, scene, or quality policy changes
- bounded ordinary-tile and timelapse-frame GPU residency
- playback buffering until the next usable frame is ready
- unit coverage for ordering, deduplication, priority, concurrency,
  cancellation, and timeline-window behavior

The optional 120–200 ms WebGPU crossfade remains deliberately deferred: the
existing parent-to-exact replacement already avoids blank flashes, and adding
blended dual-texture draws would materially restructure renderer bind groups.
The EOT1 format and raster-service API remain unchanged.

------------------------------------------------------------------------

# Final Target Architecture

``` text
                    TIMELINE
                       │
             selected acquisition
                       │
                       ▼
            Timeline Date Priority
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
    Current           Next          Previous
       │               │               │
       └───────────────┼───────────────┘
                       ▼
             TileRequestScheduler
                       │
              bounded concurrency
                       │
              spatial prioritization
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       Parent tiles           Exact tiles
            │                     │
            └──────────┬──────────┘
                       ▼
                  RasterClient
                       │
                       ▼
               Python Raster API
                       │
                       ▼
                     COG
                       │
             calibration / reprojection
                       │
                       ▼
                     EOT1
                       │
                       ▼
                 NumericTile
                       │
                NDVI / GPU upload
                       │
                       ▼
                    WebGPU
                       │
          parent → exact replacement
                       │
                       ▼
                    Canvas
```

## Guiding Principle

**Do not make the network serial just to make Timeline look ordered.**

Keep downloads parallel, but control **what gets requested first**.

The desired user experience is:

``` text
something useful quickly
        ↓
correct date
        ↓
correct area
        ↓
progressively sharper detail
```

rather than:

``` text
blank tiles
        ↓
random requests finish
        ↓
tiles suddenly pop into place
```
