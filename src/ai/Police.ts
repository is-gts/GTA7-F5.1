/**
 * Police pursuit: pure navigation/steering logic (unit-tested, no three.js) plus `PoliceSystem`,
 * which owns a small pool of `police`-type `VehicleEntity`s spawned/despawned as the wanted level
 * changes, drives them with that logic, and physically resolves them against the world, other
 * traffic/parked vehicles and the player's car (ramming).
 *
 * A police car has exactly two navigation modes, and the split is what keeps it out of buildings:
 *
 *  - **Route mode** (the default): the car *is* a `TrafficAgent` (Task 03's lane follower) with a
 *    directed turn chooser. It follows lane centrelines, negotiates intersections on the same
 *    circular fillets ordinary traffic uses, brakes for the cars in front and runs the same
 *    deadlock escape — the only difference from civilian traffic is that at every node it takes the
 *    turn that reduces the distance to the player (`pickRoutePath`) instead of a random one, and it
 *    cruises faster. Nothing here ever aims the car at a point off the road, so a police car can no
 *    longer "greedily" steer into a wall, and a car pointed the wrong way simply drives round the
 *    block (a full-lock U-turn into the kerb was the previous implementation's failure mode).
 *  - **Direct approach** (`computePursuitInput`): once the target is close *and* the straight line
 *    to it is clear of buildings (`clearLine`), the car aims straight at the target's led position —
 *    ramming a fleeing one, or braking to a halt alongside a stopped one so `busted` can trigger.
 *
 * Arrests: once a car has pulled up against a stopped target it *latches* into holding station
 * (`unit.arresting`) and keeps braking even though the target has started to creep — otherwise the
 * contact it is making pushes the target, the target then reads as "fleeing", and the two shove each
 * other down the street instead of the player being busted.
 *
 * Liveness: route mode inherits `Traffic.ts`'s escape manoeuvre, plus a backstop of its own for a
 * car that has ended up off the road entirely (reverse out, then rejoin the network at the nearest
 * lane). Direct mode has the same reverse manoeuvre, but it deliberately does **not** count
 * "stopped" as stuck while the controller is *holding station* next to a stationary target — that is
 * the intended end state of an arrest, and counting it as stuck used to make the car back away every
 * ~2.5 s and reset the player's 3 s busted timer for ever. An escape in direct mode drops the car
 * back to route mode for a few seconds so the full road-following brain gets a chance to untangle it.
 */
import type { Scene } from 'three';
import type { QualitySettings } from '../core/Quality';
import { pickVehiclePaint } from '../entities/VehicleCatalog';
import { VehicleEntity } from '../entities/VehicleEntity';
import {
  DEFAULT_CAR_SPEC,
  resolveVehicleStatic,
  resolveVehicleVehicle,
  stepVehicle,
  type VehicleInput,
  type VehicleSpec,
  type VehicleState,
} from '../physics/VehiclePhysics';
import type { AABB, StaticColliderGrid } from '../physics/Collision';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import { Random } from '../world/Random';
import { blockPitch, lanePoint, laneOffsetsShared, type CityData, type LanePoint, type RoadEdge } from '../world/CityGenerator';
import {
  advanceTrafficAgent,
  createTrafficAgent,
  edgeProgress,
  laneDeviation,
  obstacleFromVehicle,
  signedLaneDeviation,
  type AdvanceAgentOptions,
  type TrafficAgent,
  type TrafficObstacle,
  type TrafficPath,
} from './Traffic';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

// -----------------------------------------------------------------------------------------------
// Road-graph helpers (pure, no three.js).
// -----------------------------------------------------------------------------------------------

/** Id of the road graph node nearest `(x, z)` (city roads form a regular rectangular grid, so this
 *  is a direct O(1) index computation rather than a search over every node). */
export function nearestNodeId(city: CityData, x: number, z: number): number {
  const p = city.params;
  const pitch = blockPitch(p);
  const totalX = p.cols * pitch;
  const totalZ = p.rows * pitch;
  const i = clamp(Math.round((x + totalX / 2) / pitch), 0, p.cols);
  const j = clamp(Math.round((z + totalZ / 2) / pitch), 0, p.rows);
  return j * (p.cols + 1) + i;
}

/** Id of the edge directly joining nodes `a` and `b` (adjacent in the grid), or -1 if none. */
export function edgeBetween(city: CityData, a: number, b: number): number {
  const edgeIds = city.roads.adjacency[a] ?? [];
  for (const id of edgeIds) {
    const e = city.roads.edges[id]!;
    if (e.a === b || e.b === b) return id;
  }
  return -1;
}

/**
 * Visit every road edge with at least one end within `radius` of `(x, z)`, without allocating.
 * Only edges whose *lower* node is the visited one are reported (the generator always adds an edge
 * from `(i, j)` to `(i+1, j)` / `(i, j+1)`, so each edge has exactly one such end) — that dedupes
 * the walk without needing a visited set.
 */
function forEachNearbyEdge(city: CityData, x: number, z: number, radius: number, visit: (edge: RoadEdge) => void): void {
  const p = city.params;
  const pitch = blockPitch(p);
  const gx = (x + (p.cols * pitch) / 2) / pitch;
  const gz = (z + (p.rows * pitch) / 2) / pitch;
  const span = radius / pitch + 1;
  const i0 = Math.max(0, Math.floor(gx - span));
  const i1 = Math.min(p.cols, Math.ceil(gx + span));
  const j0 = Math.max(0, Math.floor(gz - span));
  const j1 = Math.min(p.rows, Math.ceil(gz + span));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const nodeId = j * (p.cols + 1) + i;
      const edgeIds = city.roads.adjacency[nodeId];
      if (!edgeIds) continue;
      for (const id of edgeIds) {
        const e = city.roads.edges[id]!;
        if (e.a === nodeId) visit(e);
      }
    }
  }
}

/** Squared distance from `(x, z)` to the segment joining the two ends of `edge`. */
function distance2ToEdge(city: CityData, edge: RoadEdge, x: number, z: number): number {
  const a = city.roads.nodes[edge.a]!;
  const b = city.roads.nodes[edge.b]!;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) / len2);
  const px = x - (a.x + dx * t);
  const pz = z - (a.z + dz * t);
  return px * px + pz * pz;
}

/**
 * The lane (edge + direction of travel + lane index + progress) a car at `(x, z)` heading `heading`
 * is closest to actually being on: the nearest edge, travelled in whichever of its two directions
 * best matches the car's heading, in whichever lane of that direction it is closest to.
 *
 * This is how a police car (re)joins the road network — at spawn, after a direct-approach pass has
 * taken it off the graph, or after a collision has shoved it somewhere unexpected. Without it a car
 * keeps steering for a stale waypoint it may no longer have any road-legal way to reach.
 */
export function nearestLanePath(city: CityData, x: number, z: number, heading: number): TrafficPath {
  let bestEdge: RoadEdge | null = null;
  let bestD2 = Infinity;
  const pitch = blockPitch(city.params);
  forEachNearbyEdge(city, x, z, pitch * 1.5, (edge) => {
    const d2 = distance2ToEdge(city, edge, x, z);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestEdge = edge;
    }
  });
  if (!bestEdge) {
    // Outside the scanned neighbourhood (shouldn't happen inside the city): fall back to a full scan.
    for (const edge of city.roads.edges) {
      const d2 = distance2ToEdge(city, edge, x, z);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestEdge = edge;
      }
    }
  }
  const edge: RoadEdge = bestEdge!;
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const a = city.roads.nodes[edge.a]!;
  const b = city.roads.nodes[edge.b]!;
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const forward = ex * fx + ez * fz >= 0;
  const lanes = laneOffsetsShared(city.params);
  let lane = 0;
  let bestLaneErr = Infinity;
  for (let l = 0; l < lanes.length; l++) {
    const err = Math.abs(signedLaneDeviation(city, edge, forward, l, x, z));
    if (err < bestLaneErr) {
      bestLaneErr = err;
      lane = l;
    }
  }
  return { edgeId: edge.id, forward, lane, t: clamp01(edgeProgress(city, edge, forward, x, z)) };
}

/**
 * The turn to take at `nodeId` (arriving on `arrivalEdgeId`) to head for `(targetX, targetZ)`:
 * the neighbour with the smallest Manhattan distance to the target, never doubling back unless the
 * node is a dead end. On the city's rectangular grid, Manhattan distance to the target's own
 * position falls with every such hop, so this greedy rule is an exact shortest route — and because
 * it is applied at nodes only, the car always turns from one lane centreline onto another.
 *
 * Ties (the target lies diagonally, so both remaining axes are equally good — and on a grid both
 * really are equally short) are broken by `rng` when one is given, otherwise toward carrying
 * straight on. The coin toss matters: with a deterministic tie-break, a car chasing a target that
 * is circling a block settles into a stable orbit exactly half a lap behind it and never closes,
 * because both of them keep taking the same turn; letting equally-good turns differ breaks that
 * lock (and makes police arrive from varied directions, which is what a pursuit should look like).
 */
export function pickRoutePath(
  city: CityData,
  nodeId: number,
  arrivalEdgeId: number,
  lane: number,
  targetX: number,
  targetZ: number,
  rng?: Random,
): TrafficPath {
  const edgeIds = city.roads.adjacency[nodeId] ?? [];
  const arrivalAxis = arrivalEdgeId >= 0 ? city.roads.edges[arrivalEdgeId]?.axis : undefined;
  const lanes = laneOffsetsShared(city.params).length;
  let bestEdge = -1;
  let bestScore = Infinity;
  let bestStraight = false;
  let fallback = -1;
  /** Number of equally-good options seen so far, for reservoir-sampling the tie (see above). */
  let ties = 1;
  for (const edgeId of edgeIds) {
    if (fallback < 0) fallback = edgeId;
    if (edgeId === arrivalEdgeId && edgeIds.length > 1) continue;
    const e = city.roads.edges[edgeId]!;
    const otherId = e.a === nodeId ? e.b : e.a;
    const other = city.roads.nodes[otherId]!;
    const score = Math.abs(other.x - targetX) + Math.abs(other.z - targetZ);
    const straight = e.axis === arrivalAxis;
    let take = score < bestScore - 1e-6;
    if (!take && score < bestScore + 1e-6 && bestEdge >= 0) {
      ties++;
      take = rng ? rng.next() < 1 / ties : straight && !bestStraight;
    }
    if (take || bestEdge < 0) {
      if (score < bestScore - 1e-6) ties = 1;
      bestScore = Math.min(bestScore, score);
      bestEdge = edgeId;
      bestStraight = straight;
    }
  }
  const edgeId = bestEdge >= 0 ? bestEdge : fallback;
  const edge = city.roads.edges[edgeId]!;
  return { edgeId, forward: edge.a === nodeId, lane: Math.min(lane, lanes - 1), t: 0 };
}

/**
 * 2D segment-vs-AABB clip (Liang-Barsky): the fraction along `(x0,z0)-(x1,z1)` at which the segment
 * enters `box`, or -1 if it never does. Scalar slab arithmetic (no arrays): this runs per candidate
 * box per line-of-sight query, several times per police car per tick.
 */
export function segmentAABBEntry(x0: number, z0: number, x1: number, z1: number, box: AABB): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tmin = 0;
  let tmax = 1;
  // p = the slab's rate of change along the segment, q = the distance to the slab's plane at t=0.
  for (let i = 0; i < 4; i++) {
    const pi = i === 0 ? -dx : i === 1 ? dx : i === 2 ? -dz : dz;
    const qi = i === 0 ? x0 - box.minX : i === 1 ? box.maxX - x0 : i === 2 ? z0 - box.minZ : box.maxZ - z0;
    if (pi === 0) {
      if (qi < 0) return -1; // parallel to this slab and outside it
    } else {
      const r = qi / pi;
      if (pi < 0) {
        if (r > tmax) return -1;
        if (r > tmin) tmin = r;
      } else {
        if (r < tmin) return -1;
        if (r < tmax) tmax = r;
      }
    }
  }
  return tmin <= tmax ? tmin : -1;
}

/** Does the segment `(x0,z0)-(x1,z1)` cross `box`? */
export function segmentIntersectsAABB(x0: number, z0: number, x1: number, z1: number, box: AABB): boolean {
  return segmentAABBEntry(x0, z0, x1, z1, box) >= 0;
}

const _lineBox: AABB = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
const _lineCandidates: (AABB & { id: number })[] = [];
/** Margin (m) added around the query segment's bounding box (broad-phase only). */
const LINE_QUERY_PAD = 2;

/** Is the straight segment between the two points unobstructed by any static (building) box? */
export function clearLine(grid: StaticColliderGrid, x0: number, z0: number, x1: number, z1: number): boolean {
  _lineBox.minX = Math.min(x0, x1) - LINE_QUERY_PAD;
  _lineBox.maxX = Math.max(x0, x1) + LINE_QUERY_PAD;
  _lineBox.minZ = Math.min(z0, z1) - LINE_QUERY_PAD;
  _lineBox.maxZ = Math.max(z0, z1) + LINE_QUERY_PAD;
  grid.query(_lineBox, _lineCandidates);
  for (const box of _lineCandidates) {
    if (segmentIntersectsAABB(x0, z0, x1, z1, box)) return false;
  }
  return true;
}

/**
 * Distance (m) straight ahead of a car at `(x, z)` heading `heading` before it would enter a
 * building, capped at `maxDist`. The direct-approach controller uses it as a "don't drive into that
 * wall" speed cap: a pursuit aimed at a target that has just turned a corner is otherwise pointed
 * straight at the buildings behind the junction, and full throttle at a target is exactly how a
 * chase used to end wedged in a block.
 */
export function freeDistanceAhead(grid: StaticColliderGrid, x: number, z: number, heading: number, maxDist: number): number {
  const x1 = x + Math.sin(heading) * maxDist;
  const z1 = z + Math.cos(heading) * maxDist;
  _lineBox.minX = Math.min(x, x1) - LINE_QUERY_PAD;
  _lineBox.maxX = Math.max(x, x1) + LINE_QUERY_PAD;
  _lineBox.minZ = Math.min(z, z1) - LINE_QUERY_PAD;
  _lineBox.maxZ = Math.max(z, z1) + LINE_QUERY_PAD;
  grid.query(_lineBox, _lineCandidates);
  let best = maxDist;
  for (const box of _lineCandidates) {
    const t = segmentAABBEntry(x, z, x1, z1, box);
    if (t >= 0 && t * maxDist < best) best = t * maxDist;
  }
  return best;
}

// -----------------------------------------------------------------------------------------------
// Direct-approach controller (pure).
// -----------------------------------------------------------------------------------------------

/** What a police car is chasing: position + velocity, used to lead the pursuit a little. */
export interface PursuitTarget {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Half-length (m) of the target's own body, for a gap (not centre-to-centre) stop distance. */
  halfLength?: number;
}

/** A `VehicleInput` plus whether the controller is deliberately standing still (see `holding`). */
export interface PursuitInput extends VehicleInput {
  /**
   * True when the car is *intentionally* stopped alongside a stationary target (an arrest in
   * progress). The liveness detector must ignore "not moving" while this is set, or it undoes the
   * arrest it is waiting for.
   */
  holding: boolean;
}

/** Speed cap (m/s) used for the final, direct approach to a slow/stationary target. */
export const PURSUIT_CRUISE_SPEED = 16;
/** Cruise speed (m/s) on a straight in route mode — about twice civilian traffic (6-12 m/s). A
 *  pursuit is a race: a police car that is no faster than the car it is chasing simply trails it
 *  round the block for ever. `ROUTE_TURN_SLOW_DIST` below is what lets it shed this in time for a
 *  junction. */
const ROUTE_CRUISE_SPEED = 26;
const ROUTE_CRUISE_FRACTION = 0.7;
/**
 * Speed (m/s) a police car takes an intersection fillet at, overriding `Traffic.ts`'s civilian
 * `TURN_SPEED` (4.5): a pursuit that crawled through every junction at walking pace could never run
 * down a car that keeps moving, and on a grid city the corners are where a chase is won or lost.
 * This is deliberately a little beyond the tyres (v^2/r = 16 m/s^2 on the 5 m fillet against the
 * spec's 12 m/s^2 limit), so a police car drifts wide through a junction and the Stanley controller
 * pulls it back — measured at most ~4.4 m from the lane centreline, i.e. still on the 14 m road.
 */
const ROUTE_TURN_SPEED = 9;
/** Distance (m) before a junction fillet at which a police car starts braking for it: enough to
 *  shed `ROUTE_CRUISE_SPEED` down to `ROUTE_TURN_SPEED` (~30 m at the spec's braking force) with
 *  margin, since the civilian 22 m is sized for a 12 m/s cruise. */
const ROUTE_TURN_SLOW_DIST = 44;
/** ...and the distance (m) at which the turn is decided, comfortably beyond that plus the fillet. */
const ROUTE_DECISION_DIST = 58;

/** Steer toward `point`; writes into a module scratch (no per-tick allocation). */
const _steer = { steer: 0, localAngle: 0 };
function steerToward(state: { x: number; z: number; heading: number }, px: number, pz: number): { steer: number; localAngle: number } {
  const dx = px - state.x;
  const dz = pz - state.z;
  const fx = Math.sin(state.heading);
  const fz = Math.cos(state.heading);
  const rx = -fz;
  const rz = fx;
  const forwardAmt = dx * fx + dz * fz;
  const rightAmt = dx * rx + dz * rz;
  // Angle from the nose to the point, clockwise-positive (matches steer sign): 0 = dead ahead,
  // +-PI = directly behind.
  const localAngle = Math.atan2(rightAmt, forwardAmt);
  _steer.steer = clamp(localAngle * 1.3, -1, 1);
  _steer.localAngle = localAngle;
  return _steer;
}

/** Gap (m) below which a car counts as "alongside" its target — a body-to-body distance, not
 *  centre-to-centre, so nose-to-tail contact (whose centres are ~4.5 m apart) still reads as close. */
export const RAM_STOP_GAP = 1.4;
/** Target speed (m/s) below which the pursuit stops ramming and instead brakes to a stop alongside
 *  it (so a stationary target can actually be "busted" instead of perpetually shoved). */
export const RAM_STOP_TARGET_SPEED = 2;
/** How fast the approach speed cap grows with gap (m/s per metre) while closing on a slow target. */
const APPROACH_GAIN = 1.2;
/** How much faster than a fleeing target a pursuing car tries to go (m/s) — enough to catch and ram
 *  it, but not so much that the car arrives at the target's next corner carrying 30 m/s and simply
 *  flies off the road into a building (which is how an uncapped "full throttle at the target" ram
 *  ends every chase that involves a turn). */
const RAM_OVERTAKE_MARGIN = 8;
/** ...with a floor (m/s), so closing on a slowly-rolling target is still brisk. */
const RAM_MIN_SPEED = 12;

const _pursuitInput: PursuitInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, holding: false };

/**
 * Steer/throttle toward a short lead of `target`'s predicted position — used for the final, direct
 * approach once the target is close and in the clear (see `clearLine`).
 *
 * Follows the project convention (see docs/ARCHITECTURE.md): forward = (sin h, cos h),
 * right = (-cos h, sin h), and a positive steer turns right. A target moving fast (fleeing) is
 * rammed at full throttle; a slow/stationary one is approached with a speed cap that shrinks to 0
 * as the gap closes, so the car comes to rest alongside it (`holding`) instead of shoving it.
 */
export function computePursuitInput(
  state: { x: number; z: number; heading: number; forwardSpeed?: number },
  target: PursuitTarget,
  leadTime = 0.6,
  ownHalfLength = DEFAULT_CAR_SPEC.halfLength,
  out: PursuitInput = _pursuitInput,
  arrest = false,
): PursuitInput {
  const px = target.x + target.vx * leadTime;
  const pz = target.z + target.vz * leadTime;
  const { steer, localAngle } = steerToward(state, px, pz);
  // Nearly behind: still steer to turn around, but ease off the throttle instead of full-sending
  // it while pointed the wrong way.
  const behind = Math.abs(localAngle) > 2.35;
  out.steer = steer;
  out.handbrake = false;
  out.holding = false;
  out.throttle = behind ? 0.5 : 1;
  out.brake = 0;
  const targetSpeed = Math.hypot(target.vx, target.vz);
  // `arrest` is the caller's latch (see `updatePoliceUnit`): once a car has pulled up against a
  // stopped target it must keep braking even though the target is now creeping — the contact itself
  // is what pushed it. Without that latch the two shove each other down the street for ever, the
  // "target is fleeing" test being satisfied by the push the police car is applying.
  if (arrest || targetSpeed < RAM_STOP_TARGET_SPEED) {
    const gap = Math.hypot(target.x - state.x, target.z - state.z) - ownHalfLength - (target.halfLength ?? 0);
    const desired = gap <= RAM_STOP_GAP ? 0 : Math.min(PURSUIT_CRUISE_SPEED, APPROACH_GAIN * (gap - RAM_STOP_GAP));
    const speed = state.forwardSpeed ?? 0;
    if (speed > desired + 0.3) {
      out.throttle = 0;
      out.brake = clamp01((speed - desired) / 6);
    } else if (speed < desired - 0.3) {
      out.throttle = behind ? 0.5 : 1;
      out.brake = 0;
    } else {
      out.throttle = 0;
      out.brake = 0;
    }
    // Standing beside a stopped target with nothing left to do: this is an arrest in progress, not
    // a stuck car (see the module header).
    out.holding = desired <= 0 && Math.abs(speed) < 1;
  } else {
    // Chasing a moving target: close at a bounded overspeed rather than flat out (see
    // `RAM_OVERTAKE_MARGIN`).
    const desired = Math.max(RAM_MIN_SPEED, targetSpeed + RAM_OVERTAKE_MARGIN);
    const speed = state.forwardSpeed ?? 0;
    if (speed > desired + 0.5) {
      out.throttle = 0;
      out.brake = clamp01((speed - desired) / 6);
    }
  }
  return out;
}

/** Cruise speed (m/s) a police car uses on a straight in route mode, given its own spec. */
export function pursuitCruiseSpeed(spec: VehicleSpec): number {
  return Math.min(ROUTE_CRUISE_SPEED, spec.maxSpeed * ROUTE_CRUISE_FRACTION);
}

// -----------------------------------------------------------------------------------------------
// Police unit: a lane-following traffic agent with a directed route and a direct-approach mode.
// -----------------------------------------------------------------------------------------------

/** What a police unit is chasing (the player, on foot or in their car). */
export interface PoliceFocus {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  /** Half-length (m) of the target's own body (vehicle half-length, or the on-foot radius). */
  halfLength?: number;
}

/** Straight-line range (m) within which a clear direct approach is entered... */
export const DIRECT_ENTER_RANGE = 30;
/** ...and beyond which it is abandoned for road-graph routing again (hysteresis). */
const DIRECT_EXIT_RANGE = 42;
/** How far ahead (m) the direct approach looks for a wall to avoid driving into. */
const LOOKAHEAD_DIST = 26;
/** Deceleration (m/s^2) assumed for that lookahead speed cap (below the real braking capability so
 *  the cap binds early enough for the brake controller to track it). */
const LOOKAHEAD_DECEL = 7;
/** Body gap (m) at or below which a direct approach latches into "holding an arrest"... */
const ARREST_ENTER_GAP = RAM_STOP_GAP + 1.6;
/** ...and above which the latch releases and the chase resumes (the target really did get away). */
const ARREST_RELEASE_GAP = 8;
/** Speed (m/s) below which a car that is *trying* to move counts as stuck. */
const STUCK_SPEED = 0.6;
/** Cap (s) on how far ahead of a moving target the road-graph route aims (see `updatePoliceUnit`). */
const ROUTE_LEAD_MAX = 6;
/** Seconds stuck before the direct-approach unstick manoeuvre kicks in. */
const STUCK_TIME = 1.2;
/** Seconds stuck in route mode before the same manoeuvre kicks in — longer, because the shared
 *  traffic escape (lane change / creep past, 2.5 s) gets first go at anything road-shaped; this one
 *  is the backstop for a car that has ended up off the road entirely, wedged against a building,
 *  where reversing out is the only thing that can help. */
const ROUTE_STUCK_TIME = 3.2;
/** Length (s) of that manoeuvre (reverse under opposite lock). Long enough to actually clear a
 *  building corner the nose has buried itself in, unlike a brief nudge. */
const ESCAPE_DURATION = 2.2;
/** After an escape, stay on road-graph routing for this long (s) before trying a direct approach
 *  again — the full lane-following brain is far better at untangling a wedged car. */
const DIRECT_COOLDOWN = 5;
/** Re-seed the route when the car ends up this far (m) off the lane it believes it is on. */
const RESEED_DEVIATION = 9;

export type PoliceStep = (agent: TrafficAgent, input: VehicleInput, dt: number) => void;

export interface PoliceUnit {
  /** The lane-following agent (owns state/prev/spec/path); see `Traffic.ts`. */
  agent: TrafficAgent;
  /** Whether the car is currently on the direct-approach controller. */
  direct: boolean;
  /** Whether the direct approach is deliberately holding station beside a stopped target. */
  holding: boolean;
  /** Latched once alongside a stopped target: keep braking rather than shoving it down the road. */
  arresting: boolean;
  /** Throttle/steer of the input actually applied last tick (recorded by the step hook), so route
   *  mode can tell "trying to drive and going nowhere" from "deliberately waiting". */
  lastThrottle: number;
  lastSteer: number;
  /** Seconds spent trying, and failing, to move (direct mode only). */
  stuckTime: number;
  /** Countdown of an unstick manoeuvre in progress (0 = none). */
  escapeTimer: number;
  /** Steer direction (-1/+1) the current unstick manoeuvre reverses under. */
  escapeSteer: number;
  /** Seconds left before a direct approach may be tried again. */
  directCooldown: number;
  /** Set when the route bookkeeping must be re-derived from the car's actual position. */
  needsReseed: boolean;
  /** Route target, read by the (persistent) turn chooser below. */
  routeTargetX: number;
  routeTargetZ: number;
  /** Persistent hooks handed to `advanceTrafficAgent` (bound once, no per-tick allocation). */
  readonly advance: AdvanceAgentOptions;
  /** Set at the top of each `updatePoliceUnit` call; read by `advance.step`. */
  stepFn: PoliceStep | null;
  grid: StaticColliderGrid | null;
}

function defaultStep(agent: TrafficAgent, input: VehicleInput, dt: number, grid: StaticColliderGrid | null): void {
  Object.assign(agent.prev, agent.state);
  stepVehicle(agent.state, agent.spec, input, dt);
  if (grid) resolveVehicleStatic(agent.state, agent.spec, grid);
}

/**
 * Create a police unit driving `spec`, starting on `path`. `adopt` lets the unit share an existing
 * `VehicleState` pair (a `VehicleEntity`'s) instead of owning its own, so `PoliceSystem` can render
 * and damage the very car the pure logic drives.
 */
export function createPoliceUnit(
  id: number,
  city: CityData,
  path: TrafficPath,
  spec: VehicleSpec,
  rng: Random,
  adopt?: { state: VehicleState; prev: VehicleState },
): PoliceUnit {
  const agent = createTrafficAgent(id, city, path, rng, pursuitCruiseSpeed(spec), spec);
  agent.turnSpeed = ROUTE_TURN_SPEED;
  agent.turnSlowDist = ROUTE_TURN_SLOW_DIST;
  agent.decisionDist = ROUTE_DECISION_DIST;
  if (adopt) {
    Object.assign(adopt.state, agent.state);
    Object.assign(adopt.prev, agent.state);
    agent.state = adopt.state;
    agent.prev = adopt.prev;
    agent.obstacle = obstacleFromVehicle(adopt.state, spec);
  }
  const unit: PoliceUnit = {
    agent,
    direct: false,
    holding: false,
    arresting: false,
    lastThrottle: 0,
    lastSteer: 0,
    stuckTime: 0,
    escapeTimer: 0,
    escapeSteer: 1,
    directCooldown: 0,
    needsReseed: false,
    routeTargetX: 0,
    routeTargetZ: 0,
    advance: {},
    stepFn: null,
    grid: null,
  };
  unit.advance.chooseNext = (a, nodeId, arrivalEdgeId) =>
    pickRoutePath(city, nodeId, arrivalEdgeId, a.path.lane, unit.routeTargetX, unit.routeTargetZ, a.rng);
  unit.advance.step = (a, input, dt) => {
    unit.lastThrottle = input.throttle;
    unit.lastSteer = input.steer;
    if (unit.stepFn) unit.stepFn(a, input, dt);
    else defaultStep(a, input, dt, unit.grid);
  };
  return unit;
}

const _escapeInput: VehicleInput = { throttle: 0, brake: 0.8, steer: 0, handbrake: false };

/**
 * Advance one police unit by `dt`: pick the mode, drive it, and keep its route bookkeeping honest.
 * Pure aside from mutating `unit` (and whatever `step` mutates) — unit-testable with a plain
 * `CityData` + `StaticColliderGrid` and no three.js.
 */
export function updatePoliceUnit(
  unit: PoliceUnit,
  city: CityData,
  grid: StaticColliderGrid,
  target: PoliceFocus,
  obstacles: readonly TrafficObstacle[],
  dt: number,
  step?: PoliceStep,
): void {
  unit.stepFn = step ?? null;
  unit.grid = grid;
  const agent = unit.agent;
  const state = agent.state;

  // --- unstick manoeuvre in progress ------------------------------------------------------------
  if (unit.escapeTimer > 0) {
    unit.escapeTimer = Math.max(0, unit.escapeTimer - dt);
    unit.holding = false;
    _escapeInput.steer = unit.escapeSteer;
    if (step) step(agent, _escapeInput, dt);
    else defaultStep(agent, _escapeInput, dt, grid);
    if (unit.escapeTimer === 0) unit.needsReseed = true;
    return;
  }

  // --- mode selection ---------------------------------------------------------------------------
  if (unit.directCooldown > 0) unit.directCooldown = Math.max(0, unit.directCooldown - dt);
  const dist = Math.hypot(target.x - state.x, target.z - state.z);
  const wasDirect = unit.direct;
  if (unit.direct) {
    unit.direct = dist <= DIRECT_EXIT_RANGE && clearLine(grid, state.x, state.z, target.x, target.z);
  } else if (unit.directCooldown === 0 && dist <= DIRECT_ENTER_RANGE) {
    unit.direct = clearLine(grid, state.x, state.z, target.x, target.z);
  }
  if (wasDirect && !unit.direct) {
    unit.needsReseed = true;
    unit.arresting = false;
  }

  if (unit.direct) {
    const gap = dist - agent.spec.halfLength - (target.halfLength ?? 0);
    const targetSpeed = Math.hypot(target.vx, target.vz);
    if (unit.arresting) unit.arresting = gap <= ARREST_RELEASE_GAP;
    else unit.arresting = gap <= ARREST_ENTER_GAP && targetSpeed < RAM_STOP_TARGET_SPEED;
    const input = computePursuitInput(state, target, 0.6, agent.spec.halfLength, _pursuitInput, unit.arresting);
    // Never carry more speed than can be shed before the next wall dead ahead.
    const free = freeDistanceAhead(grid, state.x, state.z, state.heading, LOOKAHEAD_DIST) - agent.spec.halfLength;
    const wallCap = Math.sqrt(2 * LOOKAHEAD_DECEL * Math.max(0, free));
    if (state.forwardSpeed > wallCap + 0.3) {
      input.throttle = 0;
      input.brake = Math.max(input.brake, clamp01((state.forwardSpeed - wallCap) / 4));
    }
    unit.holding = input.holding;
    if (step) step(agent, input, dt);
    else defaultStep(agent, input, dt, grid);
    // Liveness: only "trying to drive and not moving" counts as stuck — never a deliberate hold
    // beside a stopped target (that is the arrest the busted timer is waiting for).
    if (!input.holding && input.throttle > 0.1 && Math.abs(state.forwardSpeed) < STUCK_SPEED) unit.stuckTime += dt;
    else unit.stuckTime = Math.max(0, unit.stuckTime - dt * 3);
    if (unit.stuckTime > STUCK_TIME) {
      unit.stuckTime = 0;
      unit.escapeTimer = ESCAPE_DURATION;
      unit.escapeSteer = input.steer >= 0 ? -1 : 1;
      unit.direct = false;
      unit.directCooldown = DIRECT_COOLDOWN;
      unit.needsReseed = true;
    }
    return;
  }

  // --- route mode: lane following toward the target ---------------------------------------------
  unit.holding = false;
  // Route to where the target will be by the time this car could get there ("time to intercept",
  // capped), not to where it is now. Aiming at a fleeing car's current position makes a police car
  // trail it round the block at a fixed lag for ever — a stern chase it can never win, and on a
  // circuit it locks into perfect anti-phase — whereas aiming at the interception point makes it
  // cut the corner, or turn back and meet the car head on.
  const leadTime = Math.min(ROUTE_LEAD_MAX, dist / Math.max(8, agent.cruiseSpeed));
  unit.routeTargetX = target.x + target.vx * leadTime;
  unit.routeTargetZ = target.z + target.vz * leadTime;
  const edge = city.roads.edges[agent.path.edgeId]!;
  if (unit.needsReseed || laneDeviation(city, edge, agent.path.forward, agent.path.lane, state.x, state.z) > RESEED_DEVIATION) {
    agent.path = nearestLanePath(city, state.x, state.z, state.heading);
    agent.pendingPath = null;
    agent.corner.active = false;
    agent.corner.committed = false;
    unit.needsReseed = false;
  }
  advanceTrafficAgent(agent, city, dt, obstacles, grid, unit.advance);
  // Liveness backstop: a car that is on the throttle and going nowhere (wedged against a building
  // after an overshoot, say) reverses out and rejoins the road network, rather than grinding
  // against the wall for the rest of the pursuit.
  if (unit.lastThrottle > 0.1 && Math.abs(state.forwardSpeed) < STUCK_SPEED) unit.stuckTime += dt;
  else unit.stuckTime = Math.max(0, unit.stuckTime - dt * 3);
  if (unit.stuckTime > ROUTE_STUCK_TIME) {
    unit.stuckTime = 0;
    unit.escapeTimer = ESCAPE_DURATION;
    unit.escapeSteer = unit.lastSteer >= 0 ? -1 : 1;
    unit.needsReseed = true;
    agent.stuckTime = 0;
    agent.escapeTimer = 0;
  }
}

// -----------------------------------------------------------------------------------------------
// Spawning (pure).
// -----------------------------------------------------------------------------------------------

/** A place to drop a police car: a lane point plus the path bookkeeping that goes with it. */
export interface PoliceSpawn {
  path: TrafficPath;
  x: number;
  z: number;
  heading: number;
  /** Distance (m) from the focus this spawn was chosen for. */
  distance: number;
}

const _spawnCandidates: PoliceSpawn[] = [];
const _lpA: LanePoint = { x: 0, z: 0, heading: 0 };
const _lpB: LanePoint = { x: 0, z: 0, heading: 0 };
/** Fractions along an edge sampled for a spawn (kept clear of the junctions at either end). */
const SPAWN_TS = [0.2, 0.4, 0.6, 0.8];

/**
 * Pick a road position `minDist`..`maxDist` metres from `focus` to drop a police car, facing the
 * focus. Deterministic given `rng`.
 *
 * Every lane point of every edge in the neighbourhood is enumerated and the ones inside the ring
 * are chosen from uniformly — rather than sampling random edges over the whole city and hoping one
 * lands in the ring, which on a full-size city almost never happened and dropped response cars
 * hundreds of metres away (outside `Wanted.POLICE_CONTACT_RANGE`, so the wanted level then simply
 * timed out before any police car ever arrived).
 *
 * Returns null only if the road graph is empty; otherwise the closest candidate to the ring is used
 * when the ring itself is empty (a tiny city, or a focus outside the map).
 */
export function pickPoliceSpawn(
  city: CityData,
  rng: Random,
  focus: { x: number; z: number },
  minDist: number,
  maxDist: number,
  isBlocked?: (x: number, z: number) => boolean,
): PoliceSpawn | null {
  if (city.roads.edges.length === 0) return null;
  const mid = (minDist + maxDist) / 2;
  _spawnCandidates.length = 0;
  let best: PoliceSpawn | null = null;
  let bestErr = Infinity;
  const consider = (edge: RoadEdge, radius: number): void => {
    for (const t of SPAWN_TS) {
      // Face the focus: of the two directions of travel on this edge, take the one whose heading
      // points more toward the target, so the car's very first move is toward the player rather
      // than a U-turn into the kerb.
      lanePoint(city, edge, t, true, 0, _lpA);
      lanePoint(city, edge, 1 - t, false, 0, _lpB);
      const dxA = focus.x - _lpA.x;
      const dzA = focus.z - _lpA.z;
      const dxB = focus.x - _lpB.x;
      const dzB = focus.z - _lpB.z;
      const dotA = (Math.sin(_lpA.heading) * dxA + Math.cos(_lpA.heading) * dzA) / (Math.hypot(dxA, dzA) || 1);
      const dotB = (Math.sin(_lpB.heading) * dxB + Math.cos(_lpB.heading) * dzB) / (Math.hypot(dxB, dzB) || 1);
      const forward = dotA >= dotB;
      const lp = forward ? _lpA : _lpB;
      const d = Math.hypot(lp.x - focus.x, lp.z - focus.z);
      if (d > radius) continue;
      if (isBlocked && isBlocked(lp.x, lp.z)) continue;
      const cand: PoliceSpawn = {
        path: { edgeId: edge.id, forward, lane: 0, t: forward ? t : 1 - t },
        x: lp.x,
        z: lp.z,
        heading: lp.heading,
        distance: d,
      };
      if (d >= minDist && d <= maxDist) _spawnCandidates.push(cand);
      const err = Math.abs(d - mid);
      if (err < bestErr) {
        bestErr = err;
        best = cand;
      }
    }
  };
  forEachNearbyEdge(city, focus.x, focus.z, maxDist + blockPitch(city.params), (edge) => consider(edge, maxDist));
  if (_spawnCandidates.length > 0) return _spawnCandidates[rng.int(0, _spawnCandidates.length - 1)]!;
  // Ring empty (a tiny city, or a focus off the road network): widen the search and take the
  // candidate closest to the middle of the ring rather than a random point anywhere on the map.
  forEachNearbyEdge(city, focus.x, focus.z, maxDist * 4, (edge) => consider(edge, maxDist * 4));
  return best;
}

// -----------------------------------------------------------------------------------------------
// PoliceSystem: three.js-facing pool of pursuing VehicleEntitys.
// -----------------------------------------------------------------------------------------------

/** Impact speed (m/s, from `resolveVehicleVehicle`'s impulse) above which a ram counts as contact. */
const RAM_IMPULSE_THRESHOLD = 3;
/** Cars are physically resolved (and considered for ramming/collision) only within this range (m). */
const COLLIDE_RANGE = 10;
/** Cap on accumulated damage: police cars never actually die (dead engine) from grinding against
 *  walls or getting rammed — they keep pursuing, just visibly scuffed. */
const MAX_POLICE_DAMAGE = 0.85;
/** How often (s) the "closing on the target" sample is refreshed (see `pursuing`). */
const SAMPLE_INTERVAL = 1;
/** Sampled distance must shrink by at least this much (m) over `SAMPLE_INTERVAL` to count as closing. */
const CLOSING_EPS = 0.5;
/** ...or already be this close (m) to count as pursuing regardless of the trend. */
const CLOSE_RANGE = 15;
/** Minimum separation (m) between a new spawn and an existing police car. */
const SPAWN_SEPARATION = 8;

export class PoliceSystem {
  readonly cars: VehicleEntity[] = [];
  private readonly units: PoliceUnit[] = [];
  private readonly rng: Random;
  private readonly minSpawnDist: number;
  private readonly maxSpawnDist: number;
  private sampleTimer = 0;
  private sampleDist = Infinity;
  private pursuingFlag = false;
  private nextId = 1;
  /** Reused per-car obstacle list (external obstacles + the other police cars). */
  private readonly scratch: TrafficObstacle[] = [];
  /** Bound once so `update()` allocates no closure per tick. */
  private readonly stepFns: PoliceStep[] = [];
  private stepGrid: StaticColliderGrid | null = null;

  constructor(
    private readonly registry: MaterialRegistry,
    seed: number,
    opts: { minSpawnDist?: number; maxSpawnDist?: number } = {},
  ) {
    this.rng = new Random(seed ^ 0xc0ffee);
    this.minSpawnDist = opts.minSpawnDist ?? 45;
    // Kept comfortably inside Wanted.ts's POLICE_CONTACT_RANGE (120 m): a freshly spawned car
    // reads as "in contact" the same tick it appears, so the wanted level's lose-them clock never
    // starts before the response car has even arrived.
    this.maxSpawnDist = opts.maxSpawnDist ?? 95;
  }

  get count(): number {
    return this.cars.length;
  }

  /** Distance (m) from `(x, z)` to the nearest police car's centre, or `Infinity` if there are none. */
  nearestDistance(x: number, z: number): number {
    let best = Infinity;
    for (const c of this.cars) {
      const d = Math.hypot(c.state.x - x, c.state.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /** Body-to-body gap (m) from `(x, z)` (whose own half-length is `halfLength`) to the nearest
   *  police car, or `Infinity` if there are none — used for the "busted" proximity check so a
   *  nose-to-tail (or side-by-side) contact reads as close regardless of the cars' actual length. */
  nearestGap(x: number, z: number, halfLength: number): number {
    let best = Infinity;
    for (const c of this.cars) {
      const d = Math.hypot(c.state.x - x, c.state.z - z) - c.spec.halfLength - halfLength;
      if (d < best) best = d;
    }
    return best;
  }

  /** Interpolate every active police car between its previous and current physics state — without
   *  this the cars simulate correctly but their meshes stay wherever they spawned. */
  syncVisual(alpha: number): void {
    for (const c of this.cars) c.syncVisual(alpha);
  }

  setQuality(q: QualitySettings): void {
    for (const c of this.cars) c.setQuality(q);
  }

  setLights(on: boolean): void {
    for (const c of this.cars) c.setLights(on);
  }

  /** Grow/shrink the pool toward `desired`, spawning at most one car per call (spread the cost
   *  across ticks, like `TrafficSystem`'s gradual refill) and despawning any extras immediately. */
  sync(desired: number, city: CityData, focus: { x: number; z: number; heading: number }, scene: Scene): void {
    while (this.cars.length > desired) {
      const c = this.cars.pop()!;
      this.units.pop();
      this.stepFns.pop();
      scene.remove(c.object);
      c.dispose(this.registry);
    }
    if (this.cars.length < desired) this.trySpawn(city, focus, scene);
  }

  private trySpawn(city: CityData, focus: { x: number; z: number; heading: number }, scene: Scene): boolean {
    const spot = pickPoliceSpawn(city, this.rng, focus, this.minSpawnDist, this.maxSpawnDist, (x, z) => {
      for (const c of this.cars) {
        if (Math.hypot(c.state.x - x, c.state.z - z) < SPAWN_SEPARATION) return true;
      }
      return false;
    });
    if (!spot) return false;
    const car = new VehicleEntity(this.registry, { type: 'police', paint: pickVehiclePaint(this.rng, 'police') }, spot.x, spot.z, spot.heading);
    const id = this.nextId++;
    const unit = createPoliceUnit(id, city, spot.path, car.spec, this.rng.fork(`police:${id}`), { state: car.state, prev: car.prev });
    const index = this.cars.length;
    this.cars.push(car);
    this.units.push(unit);
    this.stepFns.push((_agent, input, dt) => this.cars[index]!.step(dt, input, this.stepGrid!));
    scene.add(car.object);
    return true;
  }

  /**
   * Step every car's navigation + physics, physically separate them from each other, from parked/
   * traffic `vehicles` and from the player's car (ramming), and report a hard hit on the player via
   * `onRam`. `obstacles` is what the road-following controller yields to / follows (parked and
   * traffic cars); the police cars themselves are added per car below.
   */
  update(
    dt: number,
    target: PoliceFocus,
    city: CityData,
    grid: StaticColliderGrid,
    vehicles: readonly { state: VehicleState; spec: VehicleSpec }[],
    playerVehicle: { state: VehicleState; spec: VehicleSpec } | null,
    obstacles: readonly TrafficObstacle[],
    onRam: (impulse: number) => void,
  ): boolean {
    this.stepGrid = grid;
    // Refresh each car's obstacle view once (the same objects are then referenced by every other
    // car's scratch list below — no per-pair allocation).
    for (const unit of this.units) {
      const ob = unit.agent.obstacle;
      const s = unit.agent.state;
      ob.x = s.x;
      ob.z = s.z;
      ob.heading = s.heading;
      ob.forwardSpeed = s.forwardSpeed;
    }
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]!;
      const unit = this.units[i]!;
      let n = 0;
      for (let k = 0; k < obstacles.length; k++) this.scratch[n++] = obstacles[k]!;
      for (let j = 0; j < this.units.length; j++) {
        if (j === i) continue;
        this.scratch[n++] = this.units[j]!.agent.obstacle;
      }
      this.scratch.length = n;
      updatePoliceUnit(unit, city, grid, target, this.scratch, dt, this.stepFns[i]!);
      // Police cars never actually die from accumulated damage (walls, rams): cap it so the engine
      // (VehicleEntity.step sets maxEngineForce to 0 at damage >= 1) never actually cuts out.
      if (car.damage >= 1) car.damage = MAX_POLICE_DAMAGE;
    }

    const collideDist2 = COLLIDE_RANGE * COLLIDE_RANGE;
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i]!;
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j]!;
        if (Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) <= COLLIDE_RANGE) {
          resolveVehicleVehicle(a.state, a.spec, b.state, b.spec);
        }
      }
      for (const v of vehicles) {
        if (playerVehicle && v.state === playerVehicle.state) continue; // handled (with ram detection) below
        const dx = a.state.x - v.state.x;
        const dz = a.state.z - v.state.z;
        if (dx * dx + dz * dz > collideDist2) continue;
        resolveVehicleVehicle(a.state, a.spec, v.state, v.spec);
      }
      if (playerVehicle) {
        const dx = a.state.x - playerVehicle.state.x;
        const dz = a.state.z - playerVehicle.state.z;
        if (dx * dx + dz * dz <= collideDist2) {
          const ev = resolveVehicleVehicle(a.state, a.spec, playerVehicle.state, playerVehicle.spec);
          if (ev && ev.impulse > RAM_IMPULSE_THRESHOLD) onRam(ev.impulse);
        }
      }
    }

    // "Pursuing" means observable progress: at least one car is either already close to the target
    // or has measurably closed the distance over the last second (see `SAMPLE_INTERVAL`) — not just
    // "a police car exists somewhere", which said nothing about whether it was actually chasing.
    if (this.cars.length === 0) {
      this.pursuingFlag = false;
      this.sampleDist = Infinity;
      this.sampleTimer = 0;
    } else {
      const dist = this.nearestDistance(target.x, target.z);
      if (dist < CLOSE_RANGE) this.pursuingFlag = true;
      this.sampleTimer += dt;
      if (this.sampleTimer >= SAMPLE_INTERVAL) {
        this.sampleTimer = 0;
        if (dist < this.sampleDist - CLOSING_EPS) this.pursuingFlag = true;
        else if (dist >= CLOSE_RANGE) this.pursuingFlag = false;
        this.sampleDist = dist;
      }
    }
    return this.pursuingFlag;
  }

  dispose(scene: Scene): void {
    for (const c of this.cars) {
      scene.remove(c.object);
      c.dispose(this.registry);
    }
    this.cars.length = 0;
    this.units.length = 0;
    this.stepFns.length = 0;
    this.pursuingFlag = false;
    this.sampleDist = Infinity;
    this.sampleTimer = 0;
  }
}
