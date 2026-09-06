# Task 01 — Traffic AI

## Goal
Populate the roads with AI-driven cars that follow lanes, turn at intersections, keep distance from
vehicles ahead (including the player), and stop/yield sensibly, so the city feels alive and the
player has things to weave through and crash into.

## Design
* New module `src/ai/Traffic.ts` (pure logic + a thin `TrafficSystem` that owns `VehicleEntity`s).
  * Pure path logic operates on `CityData.roads` (nodes/edges) with `lanePoint()` from
    `src/world/CityGenerator.ts`. Right-hand traffic: an agent travelling along an edge uses lane
    index 0 (inner) or 1 (outer) on the right of its direction of travel.
  * Each agent: current edge, direction (forward/back), lane, progress `t`, target speed, and a
    controller that produces `VehicleInput` (throttle/brake/steer) for `stepVehicle` — i.e. AI cars
    use the same physics as the player (`VehicleEntity.step`). Use a pure-pursuit style steer toward
    a look-ahead point on the lane; steer sign convention: positive steer turns right (see
    ARCHITECTURE.md).
  * At a node, choose the next edge deterministically from a `Random` fork (never U-turn unless
    dead end); slow down before turns; simple intersection rule: yield to a vehicle already inside
    the intersection box; a slower vehicle ahead in the same lane within a gap distance → match its
    speed / brake. Player vehicle counts as an obstacle.
  * Spawning: keep up to `quality.maxTraffic` agents within `spawnRadius` (~ drawDistance) of the
    player, spawned out of view where possible and despawned beyond `despawnRadius`. Pool
    `VehicleEntity`s (no per-frame allocation, no material churn).
  * Vehicle-vehicle collisions: `resolveVehicleVehicle` between nearby AI cars and the player car
    (broad-phase by distance or a simple grid). AI cars that get hit are allowed to be pushed and then
    recover onto their lane.
  * Headlights on at night (`VehicleEntity.setLights`). Colours from a palette via `Random`.
* `Game.ts`: create `TrafficSystem` after vehicles; update in `update(dt)`; sync visuals in `render`;
  rebuild count on `applyQuality`; expose counts in `snapshot()` (`traffic: { agents, moving }`).
* Keep the parked cars from the foundation as static vehicles (they are not traffic agents).

## Acceptance criteria
1. Unit tests (`tests/traffic.test.ts`): (a) an agent advanced for 30 s stays within 1.2 m of its
   lane centreline on straights; (b) it never leaves the road graph (position within roadWidth of
   some edge); (c) at nodes it picks a valid adjacent edge and never immediately reverses on a
   4-way node; (d) following: an agent behind a stopped agent reduces speed and does not overlap
   (OBB SAT returns null) after 10 s; (e) determinism: two runs with the same seed give identical
   states.
2. e2e (`e2e/smoke.spec.ts` or a new spec): on `quality=low`, snapshot reports ≥ 6 traffic agents
   after spawning, and after `simulate(300)` at least half of them have moved > 5 m; no console
   errors; draw calls on low stay < 400 with default city size.
3. Traffic count follows the preset (`maxTraffic`) and is rebuilt on `setQuality`.
4. `pnpm verify` passes.
