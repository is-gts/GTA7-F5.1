# Task 11 — Performance pass for low-spec devices

## Goal
Measurably lower CPU and GPU cost on the low/medium presets without changing the look on high/ultra:
fewer draw calls, fewer shadow casters, no per-frame garbage, and a benchmark that guards against
regressions.

## Design
* Measure first: add `__gta7.benchmark(frames)` that renders N frames and returns average/95th
  frame time (CPU side), draw calls, triangles, programs, and `simulate` cost per step. Record the
  baseline numbers in `docs/PERFORMANCE.md` before changing anything.
* Draw calls: merge the facade materials into one per chunk by moving the six facade styles into a
  `DataArrayTexture` (sampler2DArray) with a per-instance `aStyle` attribute (patch `map`,
  `emissiveMap`, `roughnessMap` sampling in the fragment shader); merge lamp+tree instanced meshes
  per chunk where materials allow; merge roads + intersections into one mesh with a single atlas.
  Target: default city on `low` renders in < 120 draw calls from the spawn view (was ~125-200) and
  `ultra` < 600 (was ~900, dominated by 4 shadow cascades).
* Shadow casters: on `low`/`medium` skip shadow casting for lamps/trees/far chunks; on CSM presets
  give distant cascades a caster distance cutoff (`csm` supports per-light `shadow.camera` bounds;
  set `castShadow=false` on chunk contents beyond the last cascade's far via the LOD far level).
* CPU: profile `Game.update` and the AI systems for allocations (use `--cpu-prof` in a headless
  run or manual review); remove per-frame `new Vector3/Array` in hot paths; use typed arrays for
  agent state if needed; make spatial queries reuse buffers (`StaticColliderGrid.query(out)` already
  does).
* Textures: on low use 256 px textures with mipmaps and anisotropy 2 (already), and drop the
  roughness maps for buildings.
* Web Worker (optional, only if it is clean): generate the city in a worker so the first frame is
  faster; keep the synchronous path for tests.
* Known hot spots reported by earlier verifiers (fix all): `Game.render` allocates a closure for
  `minimap.update` every frame and `trafficFocus()` allocates an object several times per fixed
  update; `Pedestrians.advancePedestrian` allocates an OBB + circle per agent×obstacle pair twice per
  tick and tests every vehicle without distance culling; `PedestrianSystem.update` copies every
  obstacle with `Object.assign` each tick; `VehicleEntity.updateEffects` rewrites paint/dent
  visuals every fixed step for every vehicle even when undamaged; `Wanted.stepWanted` returns fresh
  objects every tick; `LocalLights.selectNearestLamps` scans every lamp every frame (use the chunk
  index); light-pool decals and the star field are drawn during the day at opacity 0 (hide them).
* Shader program churn: `renderer.info.programs` grows by ~6 per low↔medium round trip because
  materials re-registered on every rebuild compile new variants (the MaterialRegistry generation key
  changes on each `setCSM`, and rebuilt city materials are new objects). Reuse the city materials
  across rebuilds (cache by preset-relevant parameters) and only bump the generation when the CSM
  configuration actually changes; assert in e2e that programs stop growing after the second cycle.
* SSR G-buffer pass (high/ultra, rain): `SSRPass` calls `renderer.render(scene, camera)` with the
  override material while `shadowMap.autoUpdate` is true, so every CSM cascade shadow map is
  rendered a second (with GTAO a third) time per frame; disable shadow-map updates around the
  G-buffer render (`renderer.shadowMap.autoUpdate=false; needsUpdate=false` and restore) and mark
  the pass so only opaque ground-level receivers are drawn (skip the rain InstancedMesh, sky, stars,
  decals via `layers`). TAA/GTAO/SSR should share the scene depth where possible.
* Weather/TAA allocations: `stepWeather` returns a new state object every fixed update,
  `applyTimeOfDay` allocates a Color + options object per call, `buildJitterOffset` allocates per
  frame — make them write into reusable objects.
* Resolution: verify adaptive resolution actually engages under load (simulate slow frames by
  feeding `AdaptiveResolution.update` — already unit-tested) and that the HUD shows the scale.

## Acceptance criteria
1. `docs/PERFORMANCE.md` with before/after numbers from `__gta7.benchmark` on low/medium/high/ultra
   (headless SwiftShader is the only GPU here; report CPU frame time and draw calls, and note that
   GPU time cannot be measured).
2. e2e budget assertions: low < 120 draw calls and ultra < 600 from the spawn view with the default
   city; `benchmark(120)` on low has no frame allocating more than 1 MB (use
   `performance.measureUserAgentSpecificMemory` if available, otherwise assert the sim step cost is
   < 0.5 ms average).
3. Screenshots on all presets look the same as before the change (verifier compares with the
   previous e2e/output images: same framing, textures, lighting).
4. `pnpm verify` passes; no console errors.
