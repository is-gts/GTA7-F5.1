# Task 08 — Weather: rain, wet roads and screen-space reflections

## Goal
A weather system with rain that darkens and wets the roads, reflects lights and the sky in the wet
asphalt on high/ultra (screen-space reflections), and stays cheap on low/medium.

## Design
* `src/world/Weather.ts` (pure): states `clear | overcast | rain`, a `wetness` scalar (0..1)
  that rises during rain and dries afterwards, transitions driven by `Random` with a minimum
  duration; settable from the menu / URL (`?weather=rain`). Unit tests for transitions and drying.
* Rain particles: a `Points`/instanced streak system in a box around the camera (e.g. 4000 streaks
  on high, 1500 medium, 600 low), animated in the vertex shader from a `time` uniform (no per-frame
  CPU updates), oriented along the fall direction plus a little wind; fades with fog; quality-gated
  count. Splash sprites optional.
* Wet surfaces: the road/intersection/concrete materials get a `wetness` uniform via
  `MaterialRegistry` patches: lower roughness (`roughness *= mix(1, 0.15, wetness)`), darken
  albedo (`*= mix(1, 0.6, wetness)`), and a puddle mask from a tiled noise texture that pushes
  roughness to ~0.02 and flattens the normal in puddles. Buildings/cars get a milder version.
* Sky/lighting: rain → overcast look (raise `turbidity`, lower sun intensity, greyer fog); the
  PMREM environment regenerates when the state changes (throttled).
* Screen-space reflections (high/ultra only; `QualitySettings.ssr: boolean` with `ssrScale`):
  implement a compact SSR pass (`src/render/SSRPass.ts`) that ray-marches the depth buffer in
  screen space (~24 steps + binary refinement) for pixels whose roughness is low (use a G-buffer
  pass of normal+roughness rendered with an override material or MRT — keep it simple: a second
  scene render with a `MeshNormalMaterial`-like override that also encodes roughness, at
  `ssrScale` resolution), blends the hit colour by Fresnel × wetness, and composites before bloom.
  Alternatively adapt three's `SSRPass` addon with `selects` = road meshes if it proves robust
  in SwiftShader — you must show a screenshot with visible reflections either way.
* Windshield/camera rain drops: skip. Thunder/audio: later task.

## Acceptance criteria
1. Unit tests for `Weather` transitions/drying and for the SSR ray-march helper if written in TS.
2. e2e: `?weather=rain&quality=high&tod=20` renders without errors; the screenshot shows rain
   streaks and reflections of lit windows/lamps on the road (verifier inspects); `snapshot()` reports
   `weather: { state: 'rain', wetness > 0.5 }` and pipeline contains `ssr`. On `quality=low` the
   same URL renders with rain but without `ssr` and stays < 400 draw calls.
3. `pnpm verify` passes; resources disposed on quality change (no growth in
   `renderer.info.memory.textures` after 5 preset switches beyond a small tolerance — add this
   check to the quality-switch e2e).
