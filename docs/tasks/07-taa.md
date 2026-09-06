# Task 07 — Temporal anti-aliasing (TAA)

## Goal
A real temporal anti-aliasing pass — sub-pixel camera jitter, history reprojection and
neighbourhood clamping — selectable as `aa: 'taa'`; it should give MSAA-like edge quality on
static geometry and remain ghosting-free on the moving car, at a cost close to FXAA.

## Design
* `src/render/TAAPass.ts` (extends `Pass` from `three/addons/postprocessing/Pass.js`):
  * Per frame: offset the camera projection by a Halton(2,3) sequence (8 or 16 samples) scaled to
    pixel size (`camera.projectionMatrix.elements[8/9]` offsets, restore after render; do not
    touch `camera.projectionMatrixInverse` inconsistently).
  * Render the scene through a `RenderPass` into an HDR colour target and read the depth texture
    (attach a `DepthTexture` to the render target). Keep the previous frame's view-projection
    matrix; in the resolve shader reproject each pixel via depth → world → previous clip space to
    fetch the history sample; clamp the history to the 3×3 neighbourhood min/max (or variance
    clip) in YCoCg; blend `mix(history, current, 1/8..1/16)`; reject history when the reprojected
    UV is off-screen or depth disagreement is large. Dynamic objects (vehicles) get correct
    results by the clamp — no velocity buffer needed; document the trade-off.
  * Two ping-pong history targets (HalfFloat, linear filtering). Handle resize (reset history).
  * Sharpen slightly (optional) to counter blur.
  * Works with the existing pipeline: RenderPass is replaced by the TAA pass when `aa === 'taa'`;
    GTAO/bloom/output still follow. The camera jitter must be applied before the shadow/CSM update
    of that frame or removed for it — keep shadows stable (jitter only the projection matrix used
    for the main render).
* `Quality.ts`: `'taa'` is already a member of `AAMode`; make `high` use `taa` and keep `smaa`
  for `medium`. Add `taaBlend` (history weight) if useful.
* Expose in `snapshot().pipeline` the pass list containing `taa` and the current jitter index.

## Acceptance criteria
1. Unit tests for the Halton sequence (values in [0,1), first 8 values exact) and for the
   projection-offset math (pure helper that builds the jitter offset from sample index and size).
2. e2e: with `?quality=high` the pipeline contains `taa`; rendering 16 consecutive frames of a
   static scene (`renderFrame()` ×16) converges: the luminance variance between frame 15 and 16 at
   sampled pixels is < 1e-4 (no flicker) and edges are smoother than `aa=none` — measure with a
   simple edge metric: sum of absolute horizontal luminance differences along a row crossing a
   building edge is lower with TAA than with `aa=none` (both captured via `readPixels`, with a
   dedicated helper that returns a row of luminance values).
3. Moving the car for 60 steps then rendering shows no obvious ghost trail (verifier inspects a
   screenshot after `simulate(60); renderFrame()` ×3).
4. `pnpm verify` passes; no console errors; the TAA pass disposes its targets on quality change.
