# Task 05 — Day/night cycle and dynamic street lighting

## Goal
Time advances on its own (sunrise → day → sunset → night), and at night the city is lit by street
lamps and the player's headlights with real local lights on capable presets, while the low preset
keeps a convincing cheap look.

## Design
* `src/game/TimeOfDay.ts` (pure): clock in hours (0-24) advancing at `secondsPerGameHour`
  (default 90 real seconds per game hour; settable; pause when `paused`), plus helpers that map
  hour → sun elevation/azimuth, daylight factor, moon direction. Unit tests for wrap-around,
  monotonic advance, daylight factor at noon/midnight and the sunrise/sunset ramps.
* `Game.ts`: use it in `update`; call `setTimeOfDay` at most every 0.5 game minutes; regenerate the
  PMREM environment only when the sun moved > 3° since the last generation (keep the throttle;
  measure that a full day causes < 40 regenerations). `snapshot()` reports `time`.
* `src/render/LocalLights.ts`: a pooled set of `PointLight`s for street lamps that follows the
  player (the N nearest lamp heads within ~60 m get a light; N = 0 on low, 4 medium, 8 high, 16 ultra
  via a new `QualitySettings.maxLocalLights` field in all presets). Lights have no shadows
  (`castShadow=false`), distance falloff ~18 m, warm colour, intensity scaled by the night factor.
  Reassign lights without allocating (reuse `PointLight` objects; update position/intensity only).
* Player car headlights: two `SpotLight`s (medium+ only; `castShadow=false`) parented to the
  vehicle, on at night; taillight glow already exists. AI traffic and police vehicles do not get spot lights (emissive headlights only).
* Low preset: emissive lamp heads + a light-pool "decal" under each nearby lamp (a flat additive
  quad with a radial gradient texture, instanced per chunk, visible only at night) so streets look
  lit without real lights.
* Sky at night: add a simple star field (`Points`, a few thousand points, fades in with darkness,
  `frustumCulled=false`, follows the camera) and keep the horizon glow.
* Exposure: as daylight fades, ease `toneMappingExposure` slightly up (night vision) so the scene
  stays readable; clamp to a sane range and keep it deterministic.

## Acceptance criteria
1. Unit tests for `TimeOfDay` (wrap, rates, daylight/moon helpers) and for the lamp-selection
   logic (nearest-N selection is stable and never exceeds N).
2. e2e: with `?tod=22&quality=medium`, snapshot reports `localLights.active ≥ 4` and the night
   screenshot shows lit pools under lamps and headlight cones on the road (verifier inspects the
   image); with `?quality=low` at night `localLights.active === 0` and light-pool decals are visible.
3. e2e: time advances: after `simulate(600)` with a fast `secondsPerGameHour` (URL param
   `?dayspeed=`), `time` increased and a PMREM regeneration counter stayed ≤ 3.
4. `pnpm verify` passes; low draw calls < 400; no console errors.
