# Task 03 — Vehicle variety, damage and horn

## Goal
Several distinct vehicle types with their own handling and looks, visible damage from crashes, and a
horn, so driving different cars feels different and crashes have consequences.

## Design
* `src/entities/VehicleCatalog.ts`: a typed table of vehicle types — at least `sedan`, `sports`,
  `suv`, `van`, `pickup`, `police` — each with a `VehicleSpec` override (mass, engine/brake force,
  grip, top speed, wheelbase, size) and body proportions (length/width/height, cabin position,
  wheel radius) plus a palette. Unit-test that every entry produces a valid spec (positive values,
  halfLength > wheelBase/2, maxSpeed reachable: engine force > drag at 60% top speed).
* `VehicleEntity` builds its mesh from the type (keep the procedural approach: boxes/cylinders, but
  vary proportions; police gets a roof light bar with emissive red/blue that can flash).
* Damage: `damage` (0..1) already accumulates from collisions. Add visuals: dents by displacing body
  panel meshes (e.g. scale/skew the front or rear bumper toward the impact side based on the contact
  normal), progressive paint scuff (darken `paint.color` toward grey via a per-vehicle material
  clone — keep material count bounded), smoke from the hood above 0.6 damage (a cheap `Points` or
  sprite emitter, quality-gated: none on low), and at 1.0 the engine is dead (max engine force 0)
  until the player exits and re-enters a different car. Reset on respawn.
* Horn (`H` key: `input.hornPressed`): visual/audio hook — emit `Game.events` `horn` and make nearby
  pedestrians flee (if Task 02 exists) — audio comes in a later task.
* Traffic (Task 01) and parked cars should use random catalog types via `Random`.
* `snapshot()` exposes the current vehicle's `type` and `damage`.

## Acceptance criteria
1. `tests/vehicleCatalog.test.ts` validates the table as above; a `sports` car reaches a higher top
   speed than a `van` in a straight-line simulation; a heavier vehicle pushes a lighter one more in
   `resolveVehicleVehicle`.
2. e2e: driving into a building at speed raises `damage` above 0.1; the snapshot reports the vehicle
   type; the low preset screenshot shows visibly different vehicles (verifier looks at the image).
3. No console errors; `pnpm verify` passes.
