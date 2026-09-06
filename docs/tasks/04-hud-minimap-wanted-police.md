# Task 04 — Minimap, wanted level and police pursuit

## Goal
GTA-style feedback loop: a minimap showing the city around the player, a wanted level that rises
when the player hurts pedestrians or wrecks cars, and police cars that pursue and ram the player
until they lose them; being stopped by police = "busted" and respawn.

## Design
* Minimap (`src/ui/Minimap.ts`): a 2D `<canvas>` in the HUD corner (~180 px) rendered at ≤ 10 Hz
  (not every frame) from `CityData.roads` (draw edges as thick lines), blocks (faint fill), the
  player (rotating arrow, map rotates with heading or north-up — pick one and keep it consistent),
  traffic/pedestrians as dots when within range, police as blue dots, mission markers later.
  Cache the static road layer in an offscreen canvas and redraw only the dynamic layer.
* Wanted system (`src/game/Wanted.ts`, pure): level 0-5 with a "heat" scalar; events add heat
  (pedestrian hit +, vehicle collision with AI car at speed +, hitting police ++); heat decays when
  no police has line of sight for N seconds; level thresholds; unit-tested state machine driven by
  `Game.events` (`pedestrianHit`, `vehicleCrash`, `policeContact`).
* Police (`src/ai/Police.ts`): police cars are traffic agents of type `police` (Task 03) with a
  pursuit controller when wanted ≥ 1: steer toward a predicted player position, throttle, ram;
  spawn count and aggression scale with wanted level (1: 1 car, 3: 3 cars, 5: 5 + roadblocks
  optional). If the player's car is stopped (< 1 m/s) with a police car within 4 m for 3 s →
  `busted`: fade, respawn at spawn on foot, wanted reset. If wanted ≥ 1 and no police within 120 m
  for 20 s → they lose you (level decays to 0).
* HUD: wanted stars (★ up to 5) top-right; "BUSTED" overlay; money/score placeholder.
* `snapshot()` gains `wanted: { level, heat }, police: { count, pursuing }, busted: boolean`.

## Acceptance criteria
1. Unit tests for the wanted state machine (thresholds, decay, reset) and for the pursuit controller
   steering toward the target (positive steer when target is to the right, etc.).
2. e2e: after running over a pedestrian at speed, `wanted.level ≥ 1` and within `simulate(600)` a
   police car is `pursuing`; stopping next to the police car for 3 s produces `busted` and a respawn
   on foot with wanted reset. Minimap canvas exists and is non-empty (`toDataURL` length > 1000).
3. Minimap redraw is throttled (assert via a counter in snapshot: redraws per 60 frames ≤ 12).
4. `pnpm verify` passes; no console errors.
