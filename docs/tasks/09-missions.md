# Task 09 — Missions and progression

## Goal
Things to do: checkpoint races and delivery jobs discovered in the world, with markers, timers,
money rewards and a save file, so a play session has goals beyond joyriding.

## Design
* `src/game/Missions.ts` (pure state machine): mission definitions generated from the city with
  `Random` (start marker on a road, ordered checkpoints for races, pickup → dropoff for deliveries),
  states `available | active | complete | failed`, timers, rewards, and a `money` total. Fail on
  timeout or wrecking the car (damage 1.0) / leaving the vehicle for > 10 s during a race.
* World markers: glowing translucent cylinders (additive, emissive, no shadows) at the start of
  each available mission and at the current checkpoint; an arrow/HUD text pointing toward the
  next checkpoint (distance in m); minimap icons (Task 04).
* Start a mission by driving into its start marker with a vehicle; progress checkpoints by
  entering the cylinder radius; completion pays money with a HUD toast.
* Save: `localStorage` record with money and completed mission ids (versioned key); reset from
  the menu.
* `snapshot()` reports `missions: { available, active: id|null, checkpoint, money }`.

## Acceptance criteria
1. Unit tests: generation is deterministic per seed, checkpoints are on roads (within roadWidth/2
   of an edge centreline) and ≥ 60 m apart; state transitions (start, checkpoint, timeout, fail on
   wreck, complete + reward, save/load round trip).
2. e2e: teleport the car into a start marker (add `__gta7.teleportVehicle(x,z,heading)`), then to
   each checkpoint in order; `money` increases on completion and survives a page reload.
3. `pnpm verify` passes; markers are disposed/rebuilt on quality change; no console errors.
