import { describe, expect, it } from 'vitest';
import {
  DIRECT_ENTER_RANGE,
  RAM_STOP_GAP,
  clearLine,
  computePursuitInput,
  createPoliceUnit,
  edgeBetween,
  nearestLanePath,
  nearestNodeId,
  pickPoliceSpawn,
  pickRoutePath,
  pursuitCruiseSpeed,
  segmentIntersectsAABB,
  updatePoliceUnit,
  type PoliceFocus,
  type PoliceUnit,
} from '../src/ai/Police';
import { obstacleFromVehicle, type TrafficObstacle } from '../src/ai/Traffic';
import { resolveVehicleSpec } from '../src/entities/VehicleCatalog';
import { StaticColliderGrid } from '../src/physics/Collision';
import {
  createVehicleState,
  resolveVehicleStatic,
  resolveVehicleVehicle,
  stepVehicle,
  DEFAULT_CAR_SPEC,
  type VehicleState,
} from '../src/physics/VehiclePhysics';
import { blockPitch, buildingAABBs, generateCity, gridLine } from '../src/world/CityGenerator';
import { LOSE_TIME, POLICE_CONTACT_RANGE } from '../src/game/Wanted';
import { Random } from '../src/world/Random';

const stationary = (x: number, z: number) => ({ x, z, vx: 0, vz: 0 });

describe('police pursuit controller', () => {
  it('steers straight (no steer) when the target is directly ahead', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(0, 20));
    expect(input.steer).toBeCloseTo(0, 5);
    expect(input.throttle).toBeGreaterThan(0);
  });

  it('steers positive (right) when the target is to the right, heading 0', () => {
    // heading 0: forward = (0,1), right = (-1,0) — a target with negative x is to the right.
    const input = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(-10, 10));
    expect(input.steer).toBeGreaterThan(0);
  });

  it('steers negative (left) when the target is to the left, heading 0', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(10, 10));
    expect(input.steer).toBeLessThan(0);
  });

  it('steer sign is consistent at a different heading (facing +X)', () => {
    // heading = PI/2: forward = (1,0), right = (0,1) — a target with positive z is to the right.
    const h = Math.PI / 2;
    const right = computePursuitInput({ x: 0, z: 0, heading: h }, stationary(10, 5));
    expect(right.steer).toBeGreaterThan(0);
    const left = computePursuitInput({ x: 0, z: 0, heading: h }, stationary(10, -5));
    expect(left.steer).toBeLessThan(0);
  });

  it('clamps steer to [-1, 1] for a target far to the side', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(-500, 0.001));
    expect(input.steer).toBeLessThanOrEqual(1);
    expect(input.steer).toBeGreaterThanOrEqual(-1);
  });

  it('eases off the throttle (but keeps steering) when the target is nearly behind', () => {
    const ahead = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(0, 20)).throttle;
    const behind = computePursuitInput({ x: 0, z: 0, heading: 0 }, stationary(0.5, -20));
    expect(behind.throttle).toBeLessThan(ahead);
    expect(behind.throttle).toBeGreaterThan(0);
  });

  it('leads a moving target ahead of its current position', () => {
    const noLead = computePursuitInput({ x: 0, z: 0, heading: 0 }, { x: -5, z: 20, vx: 0, vz: 0 }, 0).steer;
    const withLead = computePursuitInput({ x: 0, z: 0, heading: 0 }, { x: -5, z: 20, vx: -8, vz: 0 }, 0.6).steer;
    expect(withLead).toBeGreaterThan(noLead);
  });

  it('never returns a handbrake or negative throttle', () => {
    for (const [x, z] of [[5, 5], [-5, -5], [0, -20], [20, 0]] as const) {
      const input = computePursuitInput({ x: 0, z: 0, heading: 0.4 }, stationary(x, z));
      expect(input.handbrake).toBe(false);
      expect(input.brake).toBe(0);
      expect(input.throttle).toBeGreaterThanOrEqual(0);
    }
  });

  it('brakes (throttle 0) instead of ramming once alongside a slow/stationary target, and reports holding', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0, forwardSpeed: 0 }, stationary(0, 0.5));
    expect(input.throttle).toBe(0);
    expect(input.holding).toBe(true);
  });

  it('is not "holding" while still closing on the target, or while chasing a moving one', () => {
    expect(computePursuitInput({ x: 0, z: 0, heading: 0, forwardSpeed: 4 }, stationary(0, 12)).holding).toBe(false);
    expect(computePursuitInput({ x: 0, z: 0, heading: 0, forwardSpeed: 0 }, { x: 0, z: 0.5, vx: 0, vz: 12 }).holding).toBe(false);
  });

  it('sheds speed on approach to a stationary target rather than ramming at full speed', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0, forwardSpeed: 15 }, stationary(0, 4));
    expect(input.brake).toBeGreaterThan(0);
    expect(input.throttle).toBe(0);
  });

  it('still rams a fast-fleeing target even when very close (no premature braking)', () => {
    const input = computePursuitInput({ x: 0, z: 0, heading: 0, forwardSpeed: 10 }, { x: 0, z: 2, vx: 0, vz: 12 });
    expect(input.throttle).toBeGreaterThan(0);
    expect(input.brake).toBe(0);
  });
});

describe('police road-graph helpers (pure)', () => {
  const city = generateCity({ seed: 11, cols: 6, rows: 6 });

  it('nearestNodeId finds the exact node at its own position, and is stable under a small offset', () => {
    const node = city.roads.nodes[7]!;
    expect(nearestNodeId(city, node.x, node.z)).toBe(node.id);
    expect(nearestNodeId(city, node.x + 0.3, node.z - 0.2)).toBe(node.id);
  });

  it('edgeBetween finds the edge joining two adjacent nodes, and -1 for non-adjacent ones', () => {
    const a = city.roads.nodes[0]!;
    const bId = city.roads.adjacency[a.id]![0]!;
    const b = city.roads.edges[bId]!;
    const otherEnd = b.a === a.id ? b.b : b.a;
    expect(edgeBetween(city, a.id, otherEnd)).toBe(bId);
    expect(edgeBetween(city, a.id, city.roads.nodes.length - 1)).toBe(-1);
  });

  it('pickRoutePath walks the grid to the target node in exactly Manhattan-many hops, never doubling back', () => {
    const from = city.roads.nodes[0]!;
    const target = city.roads.nodes[city.roads.nodes.length - 1]!;
    let current = from.id;
    let arrivalEdge = -1;
    let hops = 0;
    const maxHops = (city.params.cols + 1) * (city.params.rows + 1);
    while (current !== target.id && hops < maxHops) {
      const currentNode = city.roads.nodes[current]!;
      const before = Math.abs(currentNode.i - target.i) + Math.abs(currentNode.j - target.j);
      const path = pickRoutePath(city, current, arrivalEdge, 0, target.x, target.z);
      const edge = city.roads.edges[path.edgeId]!;
      expect(path.forward ? edge.a : edge.b).toBe(current);
      const next = path.forward ? edge.b : edge.a;
      const nextNode = city.roads.nodes[next]!;
      const after = Math.abs(nextNode.i - target.i) + Math.abs(nextNode.j - target.j);
      expect(after).toBeLessThan(before);
      arrivalEdge = path.edgeId;
      current = next;
      hops++;
    }
    expect(current).toBe(target.id);
    expect(hops).toBe(Math.abs(from.i - target.i) + Math.abs(from.j - target.j));
  });

  it('pickRoutePath heads for the side the target is on even once standing on its nearest node', () => {
    const node = city.roads.nodes[Math.floor(city.roads.nodes.length / 2)]!;
    // Target 10 m along +X of the node: the chosen edge must lead toward +X.
    const path = pickRoutePath(city, node.id, -1, 0, node.x + 10, node.z);
    const edge = city.roads.edges[path.edgeId]!;
    const other = city.roads.nodes[path.forward ? edge.b : edge.a]!;
    expect(other.x).toBeGreaterThan(node.x);
  });

  it('nearestLanePath puts a car on the road it is standing on, travelling the way it faces', () => {
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const a = city.roads.nodes[edge.a]!;
    const b = city.roads.nodes[edge.b]!;
    const midX = (a.x + b.x) / 2;
    const headingAB = Math.atan2(b.x - a.x, b.z - a.z);
    const forward = nearestLanePath(city, midX, a.z + 3.5, headingAB);
    expect(forward.edgeId).toBe(edge.id);
    expect(forward.forward).toBe(true);
    const backward = nearestLanePath(city, midX, a.z - 3.5, headingAB + Math.PI);
    expect(backward.edgeId).toBe(edge.id);
    expect(backward.forward).toBe(false);
  });

  it('clearLine is true across open road and false when a building sits between the two points', () => {
    const grid = new StaticColliderGrid(32);
    for (const b of buildingAABBs(city)) grid.insert(b);
    const a = city.roads.nodes[0]!;
    const b = city.roads.nodes[1]!;
    expect(clearLine(grid, a.x, a.z, b.x, b.z)).toBe(true);
    const building = city.buildings[0]!;
    expect(clearLine(grid, building.x - 200, building.z, building.x + 200, building.z)).toBe(false);
  });

  it('segmentIntersectsAABB matches a direct box overlap check', () => {
    const box = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    expect(segmentIntersectsAABB(-5, 0, 5, 0, box)).toBe(true); // passes straight through
    expect(segmentIntersectsAABB(-5, 5, 5, 5, box)).toBe(false); // passes well above (in Z)
    expect(segmentIntersectsAABB(-5, -5, -2, -5, box)).toBe(false); // short segment, never reaches the box
  });
});

// -------------------------------------------------------------------------------------------------
// Integration: the real navigation, real vehicle physics and the real *default* city (14x14 blocks,
// which is what the game actually runs) — the scale at which the previous, greedy implementation
// failed (spawns hundreds of metres away, cars wedged against buildings, arrests that never
// completed). Everything here drives the same pure functions `PoliceSystem` drives.
// -------------------------------------------------------------------------------------------------

const CITY = generateCity({ seed: 7 }); // default params: 14x14 blocks
const GRID = new StaticColliderGrid(32);
for (const b of buildingAABBs(CITY)) GRID.insert(b);
const POLICE_SPEC = resolveVehicleSpec('police');
const MIN_SPAWN = 45;
const MAX_SPAWN = 95;
const DT = 1 / 60;
const NO_OBSTACLES: readonly TrafficObstacle[] = [];

/** Game.ts's busted rule, replicated exactly (see `updatePolice`). */
const BUSTED_SPEED = 1;
const BUSTED_RANGE_GAP = RAM_STOP_GAP + 0.6;
const BUSTED_RELEASE_GAP = BUSTED_RANGE_GAP + 1.2;
const BUSTED_HOLD_TIME = 3;

function spawnUnit(rng: Random, focus: { x: number; z: number }, id = 1): PoliceUnit {
  const spot = pickPoliceSpawn(CITY, rng, focus, MIN_SPAWN, MAX_SPAWN);
  expect(spot).not.toBeNull();
  return createPoliceUnit(id, CITY, spot!.path, POLICE_SPEC, rng.fork(`police:${id}`));
}

function focusAt(x: number, z: number, halfLength = DEFAULT_CAR_SPEC.halfLength): PoliceFocus {
  return { x, z, heading: 0, vx: 0, vz: 0, halfLength };
}

describe('police spawning on the default city', () => {
  it('always spawns inside the 45-95 m response ring, facing the player', () => {
    const rng = new Random(7 ^ 0xc0ffee);
    const focus = CITY.spawn;
    for (let i = 0; i < 30; i++) {
      const spot = pickPoliceSpawn(CITY, rng, focus, MIN_SPAWN, MAX_SPAWN);
      expect(spot).not.toBeNull();
      const d = Math.hypot(spot!.x - focus.x, spot!.z - focus.z);
      expect(d).toBeGreaterThanOrEqual(MIN_SPAWN - 1e-6);
      expect(d).toBeLessThanOrEqual(MAX_SPAWN + 1e-6);
      // Facing the player: the spawn heading's forward vector points at the focus.
      const toX = (focus.x - spot!.x) / d;
      const toZ = (focus.z - spot!.z) / d;
      expect(Math.sin(spot!.heading) * toX + Math.cos(spot!.heading) * toZ).toBeGreaterThan(0);
    }
  });

  it('spawns in the ring around several different focus points across the map', () => {
    const rng = new Random(1234);
    const pitch = blockPitch(CITY.params);
    for (let k = 0; k < 12; k++) {
      const node = CITY.roads.nodes[(k * 37) % CITY.roads.nodes.length]!;
      const focus = { x: node.x + pitch / 2, z: node.z };
      const spot = pickPoliceSpawn(CITY, rng, focus, MIN_SPAWN, MAX_SPAWN);
      expect(spot).not.toBeNull();
      const d = Math.hypot(spot!.x - focus.x, spot!.z - focus.z);
      expect(d).toBeGreaterThanOrEqual(MIN_SPAWN - 1e-6);
      expect(d).toBeLessThanOrEqual(MAX_SPAWN + 1e-6);
    }
  });

  it('spawns comfortably inside the wanted system\'s 120 m contact range', () => {
    const rng = new Random(99);
    for (let i = 0; i < 20; i++) {
      const spot = pickPoliceSpawn(CITY, rng, CITY.spawn, MIN_SPAWN, MAX_SPAWN)!;
      expect(Math.hypot(spot.x - CITY.spawn.x, spot.z - CITY.spawn.z)).toBeLessThan(120);
    }
  });
});

describe('police navigation on the default city (real physics)', () => {
  it('every spawned car reaches a stationary target within 60 s, without wedging against a building', () => {
    const rng = new Random(20260906);
    const target = focusAt(CITY.spawn.x, CITY.spawn.z);
    const results: number[] = [];
    for (let run = 0; run < 12; run++) {
      const unit = spawnUnit(rng, target, run + 1);
      let minDist = Infinity;
      for (let i = 0; i < 60 * 60; i++) {
        updatePoliceUnit(unit, CITY, GRID, target, NO_OBSTACLES, DT);
        const d = Math.hypot(unit.agent.state.x - target.x, unit.agent.state.z - target.z);
        if (d < minDist) minDist = d;
        if (minDist < 6) break;
      }
      results.push(minDist);
    }
    for (const d of results) expect(d).toBeLessThan(10);
  }, 60_000);

  it('re-acquires a target that drives two blocks away and stops', () => {
    const rng = new Random(4242);
    const pitch = blockPitch(CITY.params);
    for (let run = 0; run < 3; run++) {
      const first = focusAt(CITY.spawn.x, CITY.spawn.z);
      const unit = spawnUnit(rng, first, run + 1);
      let arrived = false;
      for (let i = 0; i < 60 * 60 && !arrived; i++) {
        updatePoliceUnit(unit, CITY, GRID, first, NO_OBSTACLES, DT);
        arrived = Math.hypot(unit.agent.state.x - first.x, unit.agent.state.z - first.z) < 8;
      }
      expect(arrived).toBe(true);
      // The target is now two blocks along the road it was on, stationary again.
      const second = focusAt(CITY.spawn.x + 2 * pitch, CITY.spawn.z);
      let minDist = Infinity;
      for (let i = 0; i < 60 * 60; i++) {
        updatePoliceUnit(unit, CITY, GRID, second, NO_OBSTACLES, DT);
        const d = Math.hypot(unit.agent.state.x - second.x, unit.agent.state.z - second.z);
        if (d < minDist) minDist = d;
        if (minDist < 6) break;
      }
      expect(minDist).toBeLessThan(10);
    }
  }, 60_000);

  it('keeps a car lapping a block in contact, and intercepts it in most chases', () => {
    const p = CITY.params;
    const i0 = Math.floor(p.cols / 2);
    const j0 = Math.floor(p.rows / 2);
    const corners: [number, number][] = [
      [gridLine(p, i0, 'x'), gridLine(p, j0, 'z')],
      [gridLine(p, i0 + 1, 'x'), gridLine(p, j0, 'z')],
      [gridLine(p, i0 + 1, 'x'), gridLine(p, j0 + 1, 'z')],
      [gridLine(p, i0, 'x'), gridLine(p, j0 + 1, 'z')],
    ];
    const legLen = Math.hypot(corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1]);
    const lapLength = legLen * 4;
    // A quick but plausible getaway driver: 14 m/s (50 km/h) on the straights, easing to 7 m/s for
    // each 90-degree corner — a constant-speed target that turns square corners at full speed is
    // something no car in this physics could actually be.
    const CRUISE = 14;
    const CORNER_SPEED = 7;
    const CORNER_ZONE = 14;
    let travelled = 0;
    const speedAt = (distance: number): number => {
      const within = distance % legLen;
      const toCorner = Math.min(within, legLen - within);
      return toCorner < CORNER_ZONE ? CORNER_SPEED + (CRUISE - CORNER_SPEED) * (toCorner / CORNER_ZONE) : CRUISE;
    };
    const advanceTarget = (out: PoliceFocus, dt: number): void => {
      const v = speedAt(travelled);
      travelled = (travelled + v * dt) % lapLength;
      const leg = Math.floor(travelled / legLen);
      const u = (travelled - leg * legLen) / legLen;
      const a = corners[leg]!;
      const b = corners[(leg + 1) % 4]!;
      out.x = a[0] + (b[0] - a[0]) * u;
      out.z = a[1] + (b[1] - a[1]) * u;
      out.vx = ((b[0] - a[0]) / legLen) * v;
      out.vz = ((b[1] - a[1]) / legLen) * v;
      out.heading = Math.atan2(out.vx, out.vz);
    };

    const target = focusAt(corners[0]![0], corners[0]![1]);
    const runs = 6;
    let intercepted = 0;
    for (let run = 0; run < runs; run++) {
      travelled = 0;
      advanceTarget(target, 0);
      const unit = spawnUnit(new Random(555 + run * 101), target, run + 1);
      let minDist = Infinity;
      let outOfContact = 0;
      let longestOutOfContact = 0;
      const ticks = 60 * 90;
      for (let i = 0; i < ticks; i++) {
        advanceTarget(target, DT);
        updatePoliceUnit(unit, CITY, GRID, target, NO_OBSTACLES, DT);
        const d = Math.hypot(unit.agent.state.x - target.x, unit.agent.state.z - target.z);
        if (d < minDist) minDist = d;
        if (d <= POLICE_CONTACT_RANGE) outOfContact = 0;
        else outOfContact += DT;
        if (outOfContact > longestOutOfContact) longestOutOfContact = outOfContact;
      }
      // Never shakes them off: the runner is never out of the wanted system's contact range for
      // anything like the `LOSE_TIME` it would take to lose the level (worst observed here is ~11 s
      // after a police car overshoots an interception), and the chase stays within about a block of
      // it rather than wandering off across the map.
      expect(longestOutOfContact, `run ${run} longest gap out of contact (s)`).toBeLessThan(LOSE_TIME * 0.75);
      expect(minDist, `run ${run} closest approach`).toBeLessThan(80);
      if (minDist < 30) intercepted++;
    }
    // A getaway driver who never stops and never makes a mistake can hold some of them off — but
    // most chases have to end with a police car actually on top of the target, not orbiting it.
    expect(intercepted).toBeGreaterThanOrEqual(Math.ceil(runs / 2));
  }, 90_000);

  it('runs down a target fleeing in a straight line at 14 m/s', () => {
    const rng = new Random(818);
    for (let run = 0; run < 3; run++) {
      // The target flees along the spawn road (the long +X straight through the middle of the city),
      // starting near its west end so 40 s at 14 m/s stays on the map.
      const target = focusAt(CITY.bounds.minX + 60, CITY.spawn.z);
      const unit = spawnUnit(rng, target, run + 1);
      target.vx = 14;
      target.vz = 0;
      let minDist = Infinity;
      for (let i = 0; i < 60 * 40; i++) {
        target.x += target.vx * DT;
        updatePoliceUnit(unit, CITY, GRID, target, NO_OBSTACLES, DT);
        const d = Math.hypot(unit.agent.state.x - target.x, unit.agent.state.z - target.z);
        if (d < minDist) minDist = d;
        if (minDist < 8) break;
      }
      expect(minDist, `run ${run}`).toBeLessThan(15);
    }
  }, 60_000);
});

describe('busted: a police car holds station beside a stopped player car', () => {
  /** The player's car, stationary, with no input — exactly what `Game` steps while the player idles. */
  function makePlayerCar(x: number, z: number, heading: number): VehicleState {
    return createVehicleState(x, z, heading);
  }

  it('completes an uninterrupted 3 s hold (never reversing back out of busted range) for every spawn', () => {
    const rng = new Random(31337);
    for (let run = 0; run < 8; run++) {
      const player = makePlayerCar(CITY.spawn.x, CITY.spawn.z, CITY.spawn.heading);
      const target = focusAt(player.x, player.z, DEFAULT_CAR_SPEC.halfLength);
      const unit = spawnUnit(rng, target, run + 1);
      const playerObstacle = obstacleFromVehicle(player, DEFAULT_CAR_SPEC, true);
      const obstacles = [playerObstacle];
      let holdTimer = 0;
      let bustedAt = -1;
      let maxHold = 0;
      for (let i = 0; i < 60 * 60; i++) {
        target.x = player.x;
        target.z = player.z;
        target.vx = player.vx;
        target.vz = player.vz;
        playerObstacle.x = player.x;
        playerObstacle.z = player.z;
        playerObstacle.heading = player.heading;
        playerObstacle.forwardSpeed = player.forwardSpeed;
        updatePoliceUnit(unit, CITY, GRID, target, obstacles, DT);
        // The player just sits there (no input), and is physically resolved against the cop and
        // the world exactly as `Game` does it.
        stepVehicle(player, DEFAULT_CAR_SPEC, { throttle: 0, brake: 0, steer: 0, handbrake: true }, DT);
        resolveVehicleStatic(player, DEFAULT_CAR_SPEC, GRID);
        resolveVehicleVehicle(unit.agent.state, unit.agent.spec, player, DEFAULT_CAR_SPEC);

        const gap = Math.hypot(unit.agent.state.x - player.x, unit.agent.state.z - player.z) - unit.agent.spec.halfLength - DEFAULT_CAR_SPEC.halfLength;
        const speed = Math.hypot(player.vx, player.vz);
        const limit = holdTimer > 0 ? BUSTED_RELEASE_GAP : BUSTED_RANGE_GAP;
        if (speed < BUSTED_SPEED && gap < limit) holdTimer += DT;
        else holdTimer = 0;
        if (holdTimer > maxHold) maxHold = holdTimer;
        if (holdTimer >= BUSTED_HOLD_TIME) {
          bustedAt = i * DT;
          break;
        }
      }
      expect(bustedAt, `run ${run}: never busted (longest hold ${maxHold.toFixed(2)}s)`).toBeGreaterThan(0);
      expect(bustedAt).toBeLessThan(60);
    }
  }, 90_000);
});

describe('police cruise speed', () => {
  it('is much faster than civilian traffic, and inside the vehicle\'s own top speed', () => {
    expect(pursuitCruiseSpeed(POLICE_SPEC)).toBeGreaterThan(20); // civilian traffic cruises at 6-12
    expect(pursuitCruiseSpeed(POLICE_SPEC)).toBeLessThan(POLICE_SPEC.maxSpeed);
    // A slow vehicle never gets asked to cruise faster than it can go.
    expect(pursuitCruiseSpeed({ ...POLICE_SPEC, maxSpeed: 10 })).toBeLessThanOrEqual(10);
  });
});
