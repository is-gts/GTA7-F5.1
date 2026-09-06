# Architecture

```
src/
  core/      Engine (fixed-step loop), Input (key/gamepad/virtual → actions), EventBus, Quality presets
  render/    GameRenderer (WebGLRenderer + resolution scaling), PostPipeline (EffectComposer),
             Lighting (CSM / single shadow / none + hemisphere + fog), SkyDome (Sky + PMREM env),
             Textures (procedural canvas textures), MaterialRegistry (CSM + shader patch chaining)
  world/     Random (seeded PRNG), CityGenerator (pure data: blocks, buildings, road graph, props),
             CityBuilder (three.js objects: instanced chunks, LOD, roads, ground)
  physics/   Collision (2D AABB/OBB/circle SAT + spatial hash), VehiclePhysics (arcade car model),
             CharacterController (on-foot movement)
  entities/  VehicleEntity, PlayerEntity (mesh + state + interpolation), CameraRig (chase camera)
  game/      Game (composition root: update/render systems, enter/exit vehicle, time of day, quality)
  ui/        HUD (DOM overlay)
  main.ts    bootstrap, URL parameters, window.__gta7 debug/automation API
tests/       vitest unit tests (pure modules only — no WebGL)
e2e/         Playwright smoke tests against the production build (headless SwiftShader)
```

## Conventions

* **Units**: metres, seconds, radians. Y is up; the city lies on the XZ plane.
* **Heading** `h` is rotation about +Y (`Object3D.rotation.y`). A model's front faces local +Z, so
  `forward = (sin h, cos h)` and `right = forward × up = (−cos h, sin h)`. Increasing `h` turns
  **left**; a positive steer input therefore yields a negative yaw rate. Right-hand traffic: lanes
  are offset along `right`.
* **Simulation vs rendering**: `Engine` runs `update(dt)` at a fixed 60 Hz and `render(alpha)`
  once per frame. Entities keep `prev` and `state` and interpolate visuals with `alpha`. Never read
  the DOM or the clock inside `update`.
* **Determinism**: world generation and physics are pure functions of seed/state/input so they can
  be unit-tested. Do not introduce `Math.random()` outside `Random`.
* **Materials** must be created through `MaterialRegistry.register()` so cascaded shadow maps and
  shader patches are (re)applied when the quality preset changes. Custom shader code goes in an
  `onBeforeCompile` patch passed to `register` with a unique `key`.
* **Scalability**: any new rendering feature must be gated by a `QualitySettings` field with sane
  values in all four presets (`src/core/Quality.ts`), and must dispose its GPU resources when the
  preset changes (`Game.applyQuality` rebuilds the city view, lighting and post pipeline).
* **HDR**: the scene renders linear HDR into a half-float target; tone mapping and sRGB encoding
  happen in `OutputPass`. Keep emissive/sky radiance finite (< ~64) — half-float overflows to
  `Inf` and PMREM/bloom turn `Inf` into NaN (black frames).

## Verification

`pnpm verify` runs typecheck → unit tests → build → Playwright e2e. The e2e tests use
`window.__gta7` (see `src/main.ts`): `simulate(n)` steps the fixed update without rendering,
`renderFrame()` renders once, `readPixels()` returns luminance statistics of the framebuffer, and
`snapshot()` reports mode, pipeline passes, draw calls and entity state.

## Adding a feature (checklist)

1. Pure logic first (in `world/`, `physics/`, or `core/`) with a vitest test.
2. Rendering in `render/` or `entities/` using the registry; gate cost by quality settings.
3. Wire into `Game` (`update` for simulation, `render` for visuals).
4. Extend `e2e/smoke.spec.ts` with a behavioural assertion where possible.
5. `pnpm verify` must pass; check `e2e/output/*.png` visually.
