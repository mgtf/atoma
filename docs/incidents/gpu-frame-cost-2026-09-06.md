# GPU frame cost on an integrated GPU — measured 2026-09-06

Status: **measurement plus two structural fixes.** No visual changed. The
numbers below were taken on the machine the product is developed on that day:
an AMD Ryzen 5 5500U laptop with its integrated Radeon (Vega 7) GPU, Windows
11, Chrome (Puppeteer's pinned build) on ANGLE D3D11, WebGPU backend, 60 Hz
panel at 1920×1080. They describe THAT machine. The method is reproducible with
`npm run viz:frame-probe` (`scripts/viz-frame-probe.mjs`); every JSON it wrote
during this session is summarised here rather than pasted.

## The question

"Can the WebGPU visualizer's fps be improved?" The fps readout in the header
sits below 60 on this laptop whenever the pointer moves or the Runs timeline
scrolls. Where does a frame's time go, and which of it is ours to remove?

## Method

`viz:frame-probe` drives the COMPILED client (`dist/`) through fixed
scenarios — arrival crystal (pointer away / on the gem / far from it),
Projects idle and with the pointer sweeping the rail, Runs idle and with the
pointer circling the timeline, a 32-tick wheel-scroll rebuild cycle, Registry
idle — and reports per scenario:

- rAF interval mean / P95 and the share of frames over 20 ms;
- main-thread ms per frame inside Pixi's ticker (a HIGH-priority marker to a
  UTILITY-priority one, so every app ticker plus the render);
- per-frame WebGPU call counts (render passes, draws, bind groups, `writeBuffer`
  bytes, `copyExternalImageToTexture`) and Pixi instruction rebuilds, wrapped
  at the prototype level before any app script runs;
- `--unlock` turns Chrome's vsync and frame-rate limit off, so the interval is
  the frame's COST rather than the display period;
- `--profile` takes a CDP CPU profile and maps it through the build's source
  maps; `--dirty` names the containers that dirtied each render group.

Two facts about reading these numbers, learned the hard way today:

1. **On an integrated GPU the main thread blocks inside WebGPU calls** when
   the GPU is behind: `end()`, `writeBuffer`, `submit`, `getCurrentTexture`
   carried 40–65 % of profile self-time in every idle scenario. That is
   back-pressure, not the cost of the call itself — a 287 KB `writeBuffer` does
   not take 5 ms; the thread waited there because the GPU was busy.
2. **Frame times drift with thermals.** The same build measured at DPR 1
   (1280×800, vsync unlocked) gave 2–5 ms per frame on the first run and
   6–14 ms forty minutes later; a four-arm before/after/before/after series
   could not separate the builds from the drift. Absolute frame times from
   different minutes are not comparable. Structural counters (rebuilds,
   uploads) and large effects (×2.5 and up) are.

## What the frame is made of

Baseline, unlocked vsync, 1280×800 at DPR 2 (2560×1600 device pixels), first
cool run:

| scenario | ms/frame | notes |
|---|---|---|
| welcome, pointer away | 13.4 | far field + crystal: GPU-bound |
| welcome, pointer far from crystal | 20.8 | + the pointer-light filter pass |
| projects idle | 13.1 | `end()` 63 % of self-time |
| runs idle (80 events, 528 objects) | 12.6 | `writeBuffer` 42 % of self-time |
| runs, pointer over the timeline | 24.4 | filter pass + hover |
| registry idle | 6.4 | |

The two arms that explain it:

| arm (same geometry) | projects idle | runs idle | runs hover | welcome far |
|---|---|---|---|---|
| MSAA on (default) | 11.6–13.1 | 12.6 | 15–24 | 19.7 |
| MSAA off (`antialias: false`) | 4.1–5.0 | 6.0 | 6.7 | 13.1 |
| MSAA on, DPR 1 (4× fewer pixels) | 2.6 | 3.0 | 4.2 | 4.9 |

At 2560×1600 the four-sample colour and stencil targets — cleared, written and
resolved every frame, plus a second pair whenever the pointer-light filter is
on — cost 2.5–3× everything else combined, whatever the view draws. Cutting
the shadow stack from five layers to one (a fill-rate experiment) changed
nothing measurable; the cost is the targets, not the triangles.

The WebGL fallback on this machine: 6–24 fps in Projects and hover, 167 ms
frames. WebGPU stays the backend here.

## The user's geometry

1536×800 CSS at DPR 1.25 (a maximised window on a 1920×1080 panel at 125 %
scaling), vsync on, cool machine:

| scenario | mean ms | frames > 20 ms |
|---|---|---|
| welcome / projects / runs / registry, idle | 16.7 | 0–0.4 % |
| projects, pointer sweeping the rail | 23.4 | 16.7 % |
| runs, pointer circling the timeline | 23.0 | 19.2 % |
| runs, one wheel tick (scene rebuild) | 22.7 p50, 35.6 p95 | — |

Idle holds 60 fps. Hovering and scrolling drop frames. MSAA off at this
geometry did NOT help (hover 22.9–30.6 ms, idle unchanged): below ~3–4 M
device pixels the targets are no longer the bottleneck, the hover work and the
rebuild are.

## What was found in the code, and fixed

1. **Every per-frame animation shared the root render group.** Pixi 8 keeps one
   batch geometry per render group and re-uploads the WHOLE buffer when any
   element in it moves; a redrawn batchable `Graphics` rebuilds the group's
   instruction set. The crystal's two silhouette masks are redrawn every
   frame, nav buttons and chips move sparks and scanlines every frame, so the
   root group rebuilt its instructions ~once per frame and re-uploaded every
   card, label and panel: 287 KB/frame on the 80-event trace, 0.3–0.8
   `_buildInstructions` per frame. Now `ambientRoot`, `markRoot`,
   `tooltipRoot` and every animated band (the rail, each chip row, the tile
   grid, agent lanes, the fps readout) are their own render groups through
   `ctx.animatedLayer`. The `--dirty` report after: root uploads 0 KB/frame;
   the bands upload 46 KB (rail) + 89 KB (chips) + 42 KB (tiles) + 26 KB
   (lanes) — their own geometry only. The rule is in `src/viz/AGENTS.md`.
   The first cut of this leaked: a render group's batch buffers live in
   Pixi's `BatcherPipe`, keyed by the group's instruction set, and a band
   destroyed with the scene left them behind — `viz:smoke` measured 603 → 923
   GPU buffers over one 32-tick scroll cycle, with WebGPU GC pinned off. The
   bands are now RETAINED across rebuilds (detached before the teardown,
   their children destroyed, the same container re-parented), which the smoke's
   before/after resource equality and a headless test both pin.
2. **Navigation icon relights read the GPU back into CPU memory.** The twelve
   face canvases were created with `willReadFrequently: true` for a load-time
   silhouette measurement, which made every relight (`drawImage` from the
   Three.js renderer, then Pixi's upload) a readback plus a CPU-side copy:
   `copyExternalImageToTexture` was 38.8 % of main-thread self-time while the
   pointer swept the rail. The measurement now has its own CPU canvas and the
   live canvases stay GPU-backed (20.4 % in the same scenario afterwards; still
   the largest single call, see follow-ups).

Neither shows as an fps change in this environment — the frame is GPU-bound
first and thermally unstable second — and neither was claimed to. They remove
work that scaled with the trace (the root re-upload grows with every card on
screen) and a synchronisation stall per relight.

Also added: `?atomaQuality=performance` turns MSAA off for one session, the
way `?renderer=webgl` forces the fallback. It is what the MSAA arm above was
measured with, minus the bundle surgery. It helps a weak GPU at ≥ 3–4 M device
pixels and does nothing at 1920×1080; it is not a default and not a setting.

## Where the remaining time is

- **Hover.** The pointer-light filter is a second full-frame MSAA render and
  resolve — inherent to relighting the whole stage from its own colour
  gradients. Each nav relight still synchronises three GPU contexts (Three.js
  WebGL → 2D canvas → WebGPU) twice, for the face and the white shadow mask.
- **Scroll.** A wheel tick tears the whole scene down and rebuilds it. Profile
  at the user's geometry: main thread 99.7 % busy, Pixi tessellation and
  batching 42.6 %, V8/native 21 %, event-card copy 4.4 %, i18next 2.9 %, GC
  2.3 %. 9–50 ms per tick here against 2.2–3.3 ms on the author's Metal
  machine (`viz-gpu-smoke.mjs` records that calibration).
- **Idle bands.** The rail and chip rows still mutate ~130 `Graphics` per frame
  for motion nobody sees (sparks at alpha 0, a 2.5 %-alpha scanline).

## Registered, not built

Collected here per the cooling-off rule; design each once, against all of it.

1. Derive the icon shadow mask inside WebGPU (a small render-to-texture with a
   mask-to-white shader) so a relight crosses contexts once, not twice; and
   render icons at their display size so mipmap regeneration (seven passes per
   texture per relight) goes away.
2. Scroll the Runs list by moving a retained container and virtualising rows,
   instead of rebuilding the scene per wheel tick — the same move the label
   cache made for text, extended to geometry.
3. Settle idle controls the way `eventCard` already does: no per-frame writes
   while a chip or nav button is neither active, hovered nor entering.
4. Re-measure on a cool machine, unlocked, DPR 1 and 1.25, before and after
   each of the above; keep the arms within the same ten minutes.
