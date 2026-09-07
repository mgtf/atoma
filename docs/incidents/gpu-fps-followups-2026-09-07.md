# GPU FPS follow-ups — 2026-09-07

Implements the three changes registered in the
[2026-09-06 frame-cost investigation](gpu-frame-cost-2026-09-06.md).
Work is isolated on `codex/viz-fps-followups`, based on `f230ef1`.
The earlier Radeon measurements remain historical evidence, not a prediction
for the Apple M4 Pro used here.

## Changes

1. Navigation and repository mesh faces rasterise at their physical display
   footprint, including hover scale. Optical calibration still measures on
   the original 128px grid. Dynamic face textures have no mipmap chain. Pixi
   derives the neutral white alpha mask using its shared two-backend colour
   matrix filter and a retained render texture: one external image upload per
   relight, with no shadow canvas. Face, mask and filter are released together.
2. Runs keeps a bounded window of rows, with one viewport of overscan on each
   side. A scroll-only update translates the content under the fixed viewport
   mask, updates diagnostic hit targets and re-anchors cast shadows. It retains
   the shared card material and the existing label pool. Crossing the window,
   reaching an endpoint, changing data/selection/filters, resizing or travelling
   with the camera uses the ordinary rebuild lifecycle. This removes most
   wheel rebuilds; it does not make the remaining rebuilds free. The shared
   canvas callback dispatches to the latest application handler so retention
   cannot keep an obsolete React closure.
3. Inactive navigation buttons, filter chips and agent chips stop writing
   transforms after entry and inset-shadow decay. Hover and press wake them;
   pointer exit lets them settle again. Reduced motion jumps to the final
   entrance state. Navigation icon lighting and queued spins remain independent
   of this chrome pause, including when the pointer illuminates another row.

## Measurement contract

The compiled client runs through `scripts/viz-frame-probe.mjs` on Chrome,
WebGPU/ANGLE Metal, 1280×800 CSS, unlocked vsync, DPR 1 and 1.25. Each scenario
samples 300 rAF intervals. Five arms isolate the baseline, icons, idle controls,
scroll retention, and all three together. No provider calls or live run data
are involved. Source fingerprints and start times are in
[arms.json](gpu-fps-2026-09-07/arms.json); adjacent JSON files contain raw
scenario counters and timings. Reproduce with `npm run build` then
`npm run viz:frame-probe -- --label <arm> --dpr <1|1.25> --unlock --frames 300`.

The probe now closes structural counters at the sampling boundary, before its
150ms timestamp-readback grace period. Previously it counted rendering during
that grace period against an already-finished rAF sample, inflating unlocked
per-frame counts. Counts now divide by actual Pixi ticker frames. Earlier
probe reports were not rewritten; their structural ratios are not directly
comparable to these corrected samples. Unlocked rAF intervals remain a browser
scheduling measurement; they are not a claim about the display's visible FPS.

## Results and limits

The initial ten measurements ran within about three minutes, with no page diagnostics. The
same 32-tick scroll cycle missed no updates in any arm.

- At DPR 1, scroll P50 changed from 2.0ms to 0.1ms. At DPR 1.25 it changed
  from 1.8ms to the timer's 0.0ms rounded bucket. Both combined arms retained
  the same container for 24 of 32 ticks (75%). This is a per-update CPU cost,
  not a multiplication of visible FPS.
- The tradeoff is visible in the tail: combined P95 was 3.5ms / 3.9ms versus
  baseline 3.2ms / 2.7ms, at DPR 1 / 1.25 respectively. A window crossing
  builds overscan too. The initial Runs scene grew from 533 to 662 objects;
  its retained window remains bounded independently of trace length. A fully
  incremental window refresh would be a further change if tail latency on the
  Radeon remains a problem; this result does not claim that boundary solved.
- Settling controls alone reduced Runs idle buffer uploads from 211.9KB to
  186.3KB per Pixi frame at both densities (about 12%). Combined, with the
  extra retained rows, that counter was 187.3KB. Rail uploads stay near 51KB:
  one active control still dirties its band's shared batch. No isolated FPS
  gain is established by these short, unlocked samples.
- The icon arm removes the second external upload and the mipmap chains by
  construction. The fast machine's short samples round sparse relights to
  0.0 uploads/frame, so these reports do not establish a wall-time gain for
  that arm. They do establish no new browser diagnostics. Visual and GPU
  lifetime checks remain necessary alongside these counters.

For the isolated arms, apply [icons.patch.json](gpu-fps-2026-09-07/icons.patch.json),
[idle.patch.json](gpu-fps-2026-09-07/idle.patch.json), or
[scroll.patch.json](gpu-fps-2026-09-07/scroll.patch.json) to a fresh worktree at `f230ef1`.
Each JSON's `patch` field is a unified diff; extract that string and feed it
to `git apply` in the fresh worktree. JSON escaping preserves blank context
lines without adding trailing whitespace to the repository artifact.
Use this change's corrected probe script for every arm, including baseline.
[combined.patch.json](gpu-fps-2026-09-07/combined.patch.json) reconstructs the initial
combined arm. Final review then added explicit invalidation for a resize or
camera revision batched with a scroll. The `combined-final` pair measures
that exact shipped source: P50 0.1ms at both densities, P95 3.9ms / 4.1ms,
24/32 retained ticks, no diagnostics. It was collected within eight minutes
of the original baseline. Its source fingerprints are also in `arms.json`.
Patches and fingerprints make the measured variants reconstructible without
relying on a local working copy.

## Validation

Headless regression tests execute the production button animations and Runs
view/renderer reuse paths. They cover settle/wake, bounded row retention,
translated and clipped hit targets, and invalidation on changed data,
selection or window boundaries. The real-GPU smoke additionally requires
retained wheel ticks, checks exact resource equality after a full scroll
round trip, and clicks a translated Pixi event to verify its detail opens.
Its material assertion distinguishes visible rows from the bounded overscan,
while requiring one shared face mesh for every retained card.

The account smoke also needed its missing `/api/account/subscriptions` fixture:
Settings mounts that reader even on General. The previous 404 was a fixture
failure, not a renderer error. On macOS the full suite requires modern Bash
for the existing mender `mapfile` test; Node remains the pinned 24.20.0.

Final verification: `npm run check` (3,468 passed, 12 skipped), build,
`viz:smoke` on WebGPU and WebGL, and `viz:smoke:gc` on real Metal all passed.
The GPU smoke retained 24 of 32 wheel updates, preserved exact resource counts,
and opened the clicked translated row's detail. A gated Runs overview capture
was inspected at 1600×900 CSS / DPR 2; icons, cards and clipping remained legible.
