# Task 02 — Pedestrians

## Goal
NPC pedestrians walk along sidewalks, cross at intersections, react to danger (step back / run from
fast vehicles), and get knocked down when hit; they make the city feel inhabited and are a gameplay
hook (later: wanted level).

## Design
* New module `src/ai/Pedestrians.ts`.
  * Pure sidewalk network built from `CityData.blocks`: the sidewalk ring of each block (inset
    `sidewalkWidth/2` from the block edge), plus crossing links to the neighbouring block's ring
    across each road at intersections (crosswalks). Expose it as a small graph with unit tests.
  * Agents: position/heading/state (`walk` | `wait` | `flee` | `down` | `getup`), a walk target on
    the network, speed variation. Use `CharacterController` (`stepCharacter`) for motion so
    collision handling (buildings, vehicles via `resolveCharacterOBB`) is shared with the player.
  * Danger: if a vehicle's closing speed toward the agent > ~4 m/s within ~8 m → `flee` away from
    its path for a couple of seconds. If a vehicle OBB overlaps the agent circle while the vehicle is
    faster than 2 m/s → `down` (lie flat for 4-8 s, then `getup`), and emit an event on
    `Game.events` (create an `EventBus` in Game if none) `pedestrianHit { speed }` for later systems.
  * Visuals: a shared low-poly figure (reuse the player figure's construction, factored into a
    helper) with per-agent colour variation (`InstancedMesh` or a small pool of `Group`s; ≤
    `quality.maxPedestrians`, pooled around the player like traffic). Simple walk animation is a
    plus, not required.
* `Game.ts`: `PedestrianSystem` update/render, rebuild on quality change, `snapshot()` gains
  `pedestrians: { agents, walking, down }`.

## Acceptance criteria
1. Unit tests (`tests/pedestrians.test.ts`): sidewalk graph has one ring per block with 4+ nodes,
   crossings only at intersections, and every node lies on a sidewalk (inside the block, within the
   sidewalk band); an agent walked for 60 s stays on sidewalks/crosswalks (distance to nearest
   graph edge < 1 m) and never intersects a building AABB; a moving vehicle OBB knocks an agent
   `down` and it gets up again later; determinism by seed.
2. e2e: on `quality=low` there are ≥ 8 pedestrians and after `simulate(300)` most have moved;
   driving the player car through a pedestrian at speed produces `down > 0` in the snapshot; no
   console errors.
3. `pnpm verify` passes; low preset draw calls < 400.
