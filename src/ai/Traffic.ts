/**
 * Traffic AI: cars that follow the road graph, turn at intersections, keep a gap from the
 * vehicle ahead (including the player) and yield at busy intersections — driven by the same
 * arcade vehicle physics as the player (`stepVehicle`).
 *
 * Pure logic (agent state + reference path + controller) lives first so it can be unit-tested
 * without three.js. `TrafficSystem` below is the thin three.js-facing layer: it pools cheap meshes
 * for rendering and drives the pure agents each fixed step.
 *
 * The heart of the module is the *reference path* (`pathReference`): an agent always has a
 * continuous line to follow — its lane centreline on a straight, and a circular fillet joining the
 * two lane centrelines through an intersection. The controller then only has to track that line.
 */
import { BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QualitySettings } from '../core/Quality';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import { StaticColliderGrid } from '../physics/Collision';
import {
  DEFAULT_CAR_SPEC,
  createVehicleState,
  resolveVehicleStatic,
  resolveVehicleVehicle,
  stepVehicle,
  wrapAngle,
  type VehicleInput,
  type VehicleSpec,
  type VehicleState,
} from '../physics/VehiclePhysics';
import { Random } from '../world/Random';
import { laneOffsetsShared, lanePoint, type CityData, type CityParams, type LanePoint, type RoadEdge } from '../world/CityGenerator';
import { VEHICLE_TYPES, pickVehiclePaint, pickVehicleType, resolveVehicleSpec, type VehicleType } from '../entities/VehicleCatalog';

// -----------------------------------------------------------------------------------------------
// Pure agent logic
// -----------------------------------------------------------------------------------------------

export interface TrafficPath {
  edgeId: number;
  /** true = travelling from edge.a to edge.b. */
  forward: boolean;
  lane: number;
  /** Progress along the edge in the direction of travel, 0 (start / node `a` or `b`) .. 1 (end). */
  t: number;
}

/**
 * The rounded corner (fillet) an agent follows through one intersection: the unique circular arc
 * of radius `radius` tangent to both the lane centreline it arrives on and the one it leaves on.
 *
 * Geometry, in the node-local frame (`u` along the arrival lane's heading, `w` to its right, both
 * measured from the node): the arrival lane is the line `w = laneOffset`, the departure lane is the
 * line `u = dir * laneOffset` (`dir` = +1 for a left turn, −1 for a right turn — the two lines meet
 * at the corner `(dir*laneOffset, laneOffset)`). The arc centre therefore sits at
 * `(dir*laneOffset − radius, laneOffset − dir*radius)`, and the tangent points are `radius −
 * dir*laneOffset` before the node on the arrival lane and the same distance after it on the
 * departure lane. For a right turn (`dir = −1`) that centre is the *inside* corner of the junction,
 * which is what makes the fillet valid there: an arc centred on the node itself (the naive
 * "rounded corner") is only tangent to both lanes for a left turn, and following it through a right
 * turn throws the car across the centreline into oncoming traffic.
 */
export interface CornerPlan {
  /** Whether a corner is currently planned/being negotiated. */
  active: boolean;
  /** Whether the agent has already switched its path bookkeeping onto the departing edge. */
  committed: boolean;
  nodeX: number;
  nodeZ: number;
  /** Heading of the lane the agent arrives on (the local +u axis). */
  headingIn: number;
  /** +1 = left turn, −1 = right turn. */
  dir: number;
  /** Lane centre offset (m) from the road centreline; identical on both edges. */
  laneOffset: number;
  radius: number;
}

export interface TrafficAgent {
  id: number;
  state: VehicleState;
  /** State at the previous fixed step, for render interpolation (mirrors VehicleEntity). */
  prev: VehicleState;
  spec: VehicleSpec;
  path: TrafficPath;
  /** Free-flow speed on a straight (m/s); actual speed is capped by turns/obstacles/yielding. */
  cruiseSpeed: number;
  /**
   * Speed (m/s) this agent negotiates an intersection fillet at (and brakes down to on the approach).
   * `TURN_SPEED` for ordinary traffic; police cars (`src/ai/Police.ts`) take corners harder — still
   * well inside the tyre limit for `CORNER_RADIUS`, but fast enough to actually run a fleeing car
   * down instead of losing a whole block at every junction.
   */
  turnSpeed: number;
  /**
   * Distance (m) before the fillet at which this agent starts shedding speed for it, and distance
   * (m) from a node at which it decides (and plans the fillet for) its next edge. The defaults
   * (`TURN_SLOW_DIST` / `NODE_DECISION_DIST`) suit the 6-12 m/s civilian cruise; a police car
   * cruising at 26 m/s needs ~30 m just to brake for a junction, so it looks (and commits) further
   * ahead — otherwise it arrives at the corner far too fast however hard it brakes.
   */
  turnSlowDist: number;
  decisionDist: number;
  /** Per-agent RNG for node decisions (deterministic given the parent seed). */
  rng: Random;
  /**
   * The fillet through the intersection the agent is approaching or is in the middle of. Planned
   * once, as soon as the next edge is chosen (`NODE_DECISION_DIST` before the node) — i.e. well
   * before the agent reaches the corner — and kept until the agent is clear of the arc's exit on
   * the new edge, so the reference path is continuous straight through the edge switch.
   * Mutated in place; never reallocated.
   */
  corner: CornerPlan;
  /**
   * Signed heading change (rad) of the turn taken at the last edge switch (0 for a straight-through
   * continuation). Informational (tests use its sign to tell left from right turns).
   */
  turnAngle: number;
  /**
   * The next edge/lane the agent has already committed to (decided ahead of time from `agent.rng`,
   * see `advanceTrafficAgent`), so both the corner fillet and the braking ramp onto it are known
   * before the agent gets there. Null until within `NODE_DECISION_DIST` of the node; cleared back
   * to null once the agent actually switches onto it.
   */
  pendingPath: TrafficPath | null;
  /**
   * Seconds the agent has spent effectively stopped, and the countdown of the escape manoeuvre it
   * triggers once that passes `STUCK_ESCAPE_TIME`. Together they are the population's liveness
   * guarantee (see `computeTrafficInput`): traffic that has been frozen for a while stops yielding
   * and backs up / creeps around whatever is blocking it, so a head-on or a car abandoned in a
   * junction cannot wedge the city permanently.
   */
  stuckTime: number;
  escapeTimer: number;
  /**
   * Sideways offset (m, + = right) the escape manoeuvre currently aims for, decided once when it
   * starts (see `planEscape`). 0 when the agent changed lane instead, which is the preferred way
   * around anything parked on a straight.
   */
  escapeBias: number;
  /**
   * Persistent `TrafficObstacle` view of this agent, refreshed once per population step
   * (`stepTrafficPopulation`) so other agents can reference it without allocating a fresh object
   * per pair every tick.
   */
  obstacle: TrafficObstacle;
}

/** A dynamic obstacle (another agent or the player's car) for following / yielding checks. */
export interface TrafficObstacle {
  x: number;
  z: number;
  heading: number;
  forwardSpeed: number;
  halfLength: number;
  halfWidth: number;
  /**
   * True for vehicles that are not traffic agents (parked scenery, the player's car). Standing
   * still, those are obstacles that may never move again, so traffic changes lane around them
   * rather than queueing behind them for ever; a stopped *agent* is a queue and is always followed.
   */
  parked?: boolean;
}

export function obstacleFromVehicle(state: VehicleState, spec: VehicleSpec, parked = false): TrafficObstacle {
  return { x: state.x, z: state.z, heading: state.heading, forwardSpeed: state.forwardSpeed, halfLength: spec.halfLength, halfWidth: spec.halfWidth, parked };
}

/** Distance (m) from a node at which an agent commits to its next edge. */
const NODE_SWITCH_DIST = 2.5;
/**
 * Distance (m) from a node at which the agent *decides* (but doesn't yet commit to) its next edge.
 * Must comfortably exceed `TURN_SLOW_DIST` plus the fillet's entry distance (`CORNER_RADIUS +
 * laneOffset`, at most ~10 m here) so that both the corner geometry and the braking ramp onto it
 * are known before either is needed.
 */
const NODE_DECISION_DIST = 34;
/**
 * Radius (m) of the intersection fillet. Above the vehicle's minimum turn radius
 * (`wheelBase / tan(maxSteerAngle)` = 3.95 m) with margin for the controller to correct errors,
 * and small enough that the arc stays on the road: its furthest point from the road centreline is
 * `laneOffset + 0.293 * radius`, i.e. 6.7 m < roadWidth/2 = 7 m even on the outer lane of the
 * default city.
 */
export const CORNER_RADIUS = 5;
/** Distance (m) past the fillet's exit tangent at which the corner is considered done. */
const CORNER_RELEASE_DIST = 2;
/** Start slowing for the upcoming corner this far before the fillet starts (m). */
const TURN_SLOW_DIST = 22;
/** Target speed (m/s) through a corner: v^2/CORNER_RADIUS stays far below the tyre limit. */
export const TURN_SPEED = 4.5;
/** Assumed braking deceleration (m/s^2) used to shape the pre-corner speed cap (v^2 = TURN_SPEED^2 +
 *  2*a*distance) so the agent actually reaches TURN_SPEED at the fillet instead of overshooting it.
 *  Deliberately below the vehicle's real braking capability (~10-11 m/s^2 at brake=1) so the cap
 *  starts binding early enough to give the brake controller room to track it. */
const TURN_BRAKE_DECEL = 6;
/** Heading change (rad) at a node above which the next edge counts as an actual turn rather than
 *  a straight-through continuation. */
const TURN_HEADING_THRESHOLD = 0.2;
/** Hold the corner speed cap while the agent is still this far from the reference line... */
const TURN_HOLD_LATERAL = 0.8;
/** ...or this far out of alignment with it (rad), whichever lasts longer. */
const TURN_HOLD_HEADING = 0.2;
/** Match the leader's speed once the gap ahead is under this (m). */
const FOLLOW_GAP = 9;
/** Brake to a stop once the gap ahead is under this (m). */
const BRAKE_GAP = 3.5;
/** Stop for an oncoming (head-on) vehicle this close ahead (m). */
const ONCOMING_GAP = 6;
/** Lateral offset (m) within which another car counts as "in the way" ahead. */
const LANE_TOLERANCE = 2.4;
/** Extra margin (m) added to half the road width for the intersection "box". */
const INTERSECTION_MARGIN = 3;
/** Only yield-stop for traffic already in the intersection box once this close to it (m beyond
 *  the box); farther out, the pre-corner speed cap above already handles slowing down. */
const YIELD_RANGE_MARGIN = 8;
/** Speed (m/s) below which an agent counts as stopped for the deadlock escape. */
const STUCK_SPEED = 0.4;
/** ...and above which it counts as moving again (hysteresis). */
const UNSTUCK_SPEED = 1;
/** Seconds stopped after which an agent stops yielding and creeps around what is blocking it. */
const STUCK_ESCAPE_TIME = 2.5;
/** Length (s) of one escape manoeuvre once an agent gives up waiting. */
const ESCAPE_DURATION = 6;
/** The first part of that manoeuvre backs up, to open the room the rest of it needs to steer into. */
const ESCAPE_REVERSE_TIME = 1.2;
/** Only back up when the head-on blocker is this close (m) — otherwise there is room already. */
const ESCAPE_REVERSE_GAP = 2;
/** ...and only when nothing is following this close behind (m). */
const ESCAPE_REVERSE_CLEARANCE = 3;
/** Longitudinal room (m) an agent wants in the lane it is changing into, either side of itself. */
const LANE_CHANGE_CLEARANCE = 9;
/** Speed (m/s) an escaping agent creeps past a head-on blocker at. */
const CREEP_SPEED = 2.5;
/** Sideways offset (m) an escaping agent aims for to squeeze past a head-on blocker on a straight. */
const ESCAPE_OFFSET = 1.8;
/** ...and around a vehicle that is never going to move: a full lane's width, i.e. a lane change. */
const ESCAPE_OFFSET_LANE = 3.5;
/** Stanley cross-track gain (rad of extra wheel angle per metre off the line, at 1 m/s). */
const STANLEY_CROSS_GAIN = 1.4;

const HALF_PI = Math.PI / 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Lane centre offset (m) from the road centreline for `lane` (clamped to the lanes that exist). */
export function laneOffsetOf(params: CityParams, lane: number): number {
  const offsets = laneOffsetsShared(params);
  return offsets[Math.min(Math.max(lane, 0), offsets.length - 1)] ?? 0;
}

/** Fraction along `edge` (unclamped) that (x,z) projects to, travelling in `forward` direction. */
export function edgeProgress(city: CityData, edge: RoadEdge, forward: boolean, x: number, z: number): number {
  const na = city.roads.nodes[edge.a]!;
  const nb = city.roads.nodes[edge.b]!;
  const from = forward ? na : nb;
  const to = forward ? nb : na;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len2 = dx * dx + dz * dz || 1;
  return ((x - from.x) * dx + (z - from.z) * dz) / len2;
}

/** Perpendicular distance from (x,z) to the ideal lane centreline at its own progress along `edge`. */
export function laneDeviation(city: CityData, edge: RoadEdge, forward: boolean, lane: number, x: number, z: number): number {
  const t = clamp01(edgeProgress(city, edge, forward, x, z));
  const ideal = lanePoint(city, edge, t, forward, lane);
  return Math.hypot(x - ideal.x, z - ideal.z);
}

/**
 * Signed lateral offset (m) from the ideal lane centreline at its own progress along `edge`:
 * positive = to the right of the lane (toward the kerb), negative = to the left (toward, and
 * potentially across, the road centreline into oncoming traffic).
 */
export function signedLaneDeviation(city: CityData, edge: RoadEdge, forward: boolean, lane: number, x: number, z: number): number {
  const t = clamp01(edgeProgress(city, edge, forward, x, z));
  const ideal = lanePoint(city, edge, t, forward, lane);
  const fx = Math.sin(ideal.heading);
  const fz = Math.cos(ideal.heading);
  const rx = -fz;
  const rz = fx;
  return (x - ideal.x) * rx + (z - ideal.z) * rz;
}

/** Node id the agent is currently heading toward, given its edge/direction. */
function targetNodeId(edge: RoadEdge, forward: boolean): number {
  return forward ? edge.b : edge.a;
}

/**
 * Pick the next edge/direction from a node, excluding the edge just arrived on unless that is the
 * only option (dead end) — so agents never U-turn at a real (2+ way) intersection. Deterministic
 * given `rng`.
 */
export function chooseNextPath(city: CityData, rng: Random, nodeId: number, arrivalEdgeId: number, keepLane: number): TrafficPath {
  const options = city.roads.adjacency[nodeId] ?? [];
  const candidates = options.filter((id) => id !== arrivalEdgeId);
  const pool = candidates.length > 0 ? candidates : options;
  const edgeId = pool[rng.int(0, pool.length - 1)]!;
  const edge = city.roads.edges[edgeId]!;
  const forward = edge.a === nodeId;
  const lanes = laneOffsetsShared(city.params).length;
  return { edgeId, forward, lane: Math.min(keepLane, lanes - 1), t: 0 };
}

/** Minimum distance from (x,z) to the drivable road graph (nearest edge segment, ignoring lane offset). */
export function distanceToRoadGraph(city: CityData, x: number, z: number): number {
  let best = Infinity;
  for (const e of city.roads.edges) {
    const a = city.roads.nodes[e.a]!;
    const b = city.roads.nodes[e.b]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) / len2);
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

/** Build a fresh agent standing on a given edge/direction/lane/t (spawn helper). */
export function createTrafficAgent(
  id: number,
  city: CityData,
  path: TrafficPath,
  rng: Random,
  cruiseSpeed: number,
  spec: VehicleSpec = DEFAULT_CAR_SPEC,
): TrafficAgent {
  const edge = city.roads.edges[path.edgeId]!;
  const lp = lanePoint(city, edge, path.t, path.forward, path.lane);
  const state = createVehicleState(lp.x, lp.z, lp.heading);
  // Spawn rolling rather than from a standstill: traffic that has to accelerate from 0 every time
  // it appears reads as a car park, and a stationary spawn right in front of the player is worse
  // than one already moving with the flow.
  const v0 = Math.min(cruiseSpeed, 8);
  state.vx = Math.sin(lp.heading) * v0;
  state.vz = Math.cos(lp.heading) * v0;
  state.forwardSpeed = v0;
  return {
    id,
    state,
    prev: { ...state },
    spec,
    path: { ...path },
    cruiseSpeed,
    turnSpeed: TURN_SPEED,
    turnSlowDist: TURN_SLOW_DIST,
    decisionDist: NODE_DECISION_DIST,
    rng,
    corner: { active: false, committed: false, nodeX: 0, nodeZ: 0, headingIn: 0, dir: 1, laneOffset: 0, radius: CORNER_RADIUS },
    turnAngle: 0,
    pendingPath: null,
    stuckTime: 0,
    escapeTimer: 0,
    escapeBias: 0,
    obstacle: obstacleFromVehicle(state, spec),
  };
}

// --- reference path ----------------------------------------------------------------------------

/** Which part of the reference path the agent is currently on. */
export const PHASE_LANE = 0;
/** On the straight lane before a planned corner. */
export const PHASE_APPROACH = 1;
/** On the corner fillet. */
export const PHASE_ARC = 2;
/** On the straight lane after the corner fillet. */
export const PHASE_EXIT = 3;

export interface PathReference {
  /** Nearest point on the reference path. */
  x: number;
  z: number;
  /** Direction of travel of the reference path there. */
  heading: number;
  /** Path curvature as a steer direction: positive = the path bends right (see ARCHITECTURE.md). */
  steerCurvature: number;
  phase: number;
  /** Distance (m) still to run before the fillet (PHASE_APPROACH) or since it ended (PHASE_EXIT). */
  arcDistance: number;
}

export function createPathReference(): PathReference {
  return { x: 0, z: 0, heading: 0, steerCurvature: 0, phase: PHASE_LANE, arcDistance: 0 };
}

/**
 * Plan the fillet for the turn from `edge` (travelling `forward` in lane `lane`) onto `next` at
 * the node between them. Returns false — and deactivates `corner` — when the manoeuvre is not a
 * ~90 degree turn (a straight-through continuation, or the U-turn at a dead end), in which case
 * the agent simply follows the lane centrelines.
 */
export function planCorner(corner: CornerPlan, city: CityData, edge: RoadEdge, forward: boolean, lane: number, next: TrafficPath, nodeId: number): boolean {
  const nextEdge = city.roads.edges[next.edgeId]!;
  const headingIn = lanePoint(city, edge, 1, forward, lane).heading;
  const headingOut = lanePoint(city, nextEdge, 0, next.forward, next.lane).heading;
  const turn = wrapAngle(headingOut - headingIn);
  const laneOffset = laneOffsetOf(city.params, lane);
  corner.active = false;
  corner.committed = false;
  // Only a quarter-turn between equally offset lanes has this single-arc fillet (the city's road
  // graph is a grid, so every real turn is one); anything else falls back to plain lane following.
  if (Math.abs(Math.abs(turn) - HALF_PI) > 0.15) return false;
  if (Math.abs(laneOffsetOf(city.params, next.lane) - laneOffset) > 1e-6) return false;
  const node = city.roads.nodes[nodeId]!;
  corner.active = true;
  corner.nodeX = node.x;
  corner.nodeZ = node.z;
  corner.headingIn = headingIn;
  corner.dir = turn > 0 ? 1 : -1;
  corner.laneOffset = laneOffset;
  corner.radius = CORNER_RADIUS;
  return true;
}

/**
 * Nearest point (and its direction and curvature) on the fillet's three-part path — straight in,
 * arc, straight out — for a car at (x,z). Everything is computed in the node-local frame described
 * on `CornerPlan`; `psi` is the angle of the car around the arc centre, whose quarter-circle span
 * is [−90°, 0°] travelled with `psi` increasing for a right turn and [0°, +90°] travelled with
 * `psi` decreasing for a left turn — outside that span the car is still on (or already past) one
 * of the two straights.
 */
export function cornerReference(corner: CornerPlan, x: number, z: number, out: PathReference): PathReference {
  const fx = Math.sin(corner.headingIn);
  const fz = Math.cos(corner.headingIn);
  const rx = -fz;
  const rz = fx;
  const px = x - corner.nodeX;
  const pz = z - corner.nodeZ;
  const u = px * fx + pz * fz;
  const w = px * rx + pz * rz;
  const d = corner.laneOffset;
  const r = corner.radius;
  const dir = corner.dir;
  const cu = dir * d - r;
  const cw = d - dir * r;
  const psi = Math.atan2(w - cw, u - cu);

  let refU: number;
  let refW: number;
  let heading: number;
  if (dir < 0 ? psi < -HALF_PI : psi > HALF_PI) {
    // Still on the straight lane leading in: the line w = laneOffset, travelled along +u.
    refU = u;
    refW = d;
    heading = corner.headingIn;
    out.steerCurvature = 0;
    out.phase = PHASE_APPROACH;
    out.arcDistance = cu - u;
  } else if (dir < 0 ? psi > 0 : psi < 0) {
    // Past the arc, on the straight lane leading out: the line u = dir*laneOffset.
    refU = dir * d;
    refW = w;
    heading = wrapAngle(corner.headingIn + dir * HALF_PI);
    out.steerCurvature = 0;
    out.phase = PHASE_EXIT;
    out.arcDistance = -dir * (w - cw);
  } else {
    const cosP = Math.cos(psi);
    const sinP = Math.sin(psi);
    refU = cu + r * cosP;
    refW = cw + r * sinP;
    // Tangent of the arc in the direction of travel (psi increases through a right turn, decreases
    // through a left one), rotated back into world space below.
    const tu = dir < 0 ? -sinP : sinP;
    const tw = dir < 0 ? cosP : -cosP;
    heading = Math.atan2(tu * fx + tw * rx, tu * fz + tw * rz);
    out.steerCurvature = -dir / r;
    out.phase = PHASE_ARC;
    out.arcDistance = 0;
  }
  out.x = corner.nodeX + refU * fx + refW * rx;
  out.z = corner.nodeZ + refU * fz + refW * rz;
  out.heading = heading;
  return out;
}

const _lanePoint: LanePoint = { x: 0, z: 0, heading: 0 };

/** The point on the agent's reference path (lane centreline, or intersection fillet) to track. */
export function pathReference(agent: TrafficAgent, city: CityData, out: PathReference): PathReference {
  if (agent.corner.active) return cornerReference(agent.corner, agent.state.x, agent.state.z, out);
  const edge = city.roads.edges[agent.path.edgeId]!;
  // Unclamped `t`: the lane centreline is a straight line, so projecting onto its infinite
  // extension is exactly right (and continuous) even a metre or two beyond either node.
  const t = edgeProgress(city, edge, agent.path.forward, agent.state.x, agent.state.z);
  lanePoint(city, edge, t, agent.path.forward, agent.path.lane, _lanePoint);
  out.x = _lanePoint.x;
  out.z = _lanePoint.z;
  out.heading = _lanePoint.heading;
  out.steerCurvature = 0;
  out.phase = PHASE_LANE;
  out.arcDistance = 0;
  return out;
}

// --- controller --------------------------------------------------------------------------------

/**
 * Sideways offset (m, positive = right) an agent aims for while getting past something that is not
 * going to move, when a proper lane change isn't available. Always toward the kerb, and only as far
 * as the road surface allows: dodging the other way would put the car in a lane it has just been
 * told is occupied, and on a single-lane road it would be the oncoming one.
 */
function escapeOffset(params: CityParams, laneOffset: number, wanted: number): number {
  return Math.max(0, Math.min(wanted, params.roadWidth / 2 - 1.2 - laneOffset));
}

/** Is this obstacle sitting on the junction the agent is heading for? */
function isOnCrossing(ob: TrafficObstacle, city: CityData, nodeX: number, nodeZ: number): boolean {
  const crossHalf = city.params.roadWidth / 2;
  const ndx = ob.x - nodeX;
  const ndz = ob.z - nodeZ;
  return ndx * ndx + ndz * ndz < crossHalf * crossHalf;
}

/**
 * Is this obstacle a queue to join, or a dead end? A stopped *agent* is traffic and will drive on,
 * so it is followed. A parked vehicle (street furniture, or a car the player left behind) and
 * anything stalled on the crossing itself never will, so the escape manoeuvre is allowed to get
 * around it. "On the crossing" is the paved junction rather than the wider yield box, so cars
 * legitimately queueing to enter a junction (they stop outside the box) are never overtaken.
 */
function isDeadEnd(ob: TrafficObstacle, city: CityData, nodeX: number, nodeZ: number): boolean {
  if (Math.abs(ob.forwardSpeed) >= 0.3) return false;
  return ob.parked === true || isOnCrossing(ob, city, nodeX, nodeZ);
}

const _escapeRef = createPathReference();

/**
 * Decide, once, how an agent that has given up waiting is going to get past whatever is in front of
 * it, and return the sideways offset (m, + = right) its steering should aim for until the escape
 * expires. The preferred answer is a proper lane change — the agent's `path.lane` moves to the
 * clear lane and the reference path follows, so it drives correctly in the new lane rather than
 * hovering off the line of the old one. Where that isn't possible (mid-junction, single-lane road,
 * or the other lane is occupied) it falls back to aiming off-line: a lane's width around something
 * parked, or half a car's width to slip past an oncoming car nose to nose.
 */
export function planEscape(agent: TrafficAgent, city: CityData, obstacles: readonly TrafficObstacle[]): number {
  const s = agent.state;
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  const rx = -fz;
  const rz = fx;
  const edge = city.roads.edges[agent.path.edgeId]!;
  const node = city.roads.nodes[targetNodeId(edge, agent.path.forward)]!;
  let deadAhead = false;
  let deadOnCrossing = false;
  let headOn = false;
  for (let i = 0; i < obstacles.length; i++) {
    const ob = obstacles[i]!;
    const odx = ob.x - s.x;
    const odz = ob.z - s.z;
    const along = odx * fx + odz * fz;
    if (along <= 0) continue;
    const lateral = odx * rx + odz * rz;
    if (Math.abs(lateral) > LANE_TOLERANCE) continue;
    if (along - agent.spec.halfLength - ob.halfLength > FOLLOW_GAP) continue;
    if (Math.sin(ob.heading) * fx + Math.cos(ob.heading) * fz < -0.5) headOn = true;
    else if (isDeadEnd(ob, city, node.x, node.z)) {
      deadAhead = true;
      if (isOnCrossing(ob, city, node.x, node.z)) deadOnCrossing = true;
    }
  }
  const offsets = laneOffsetsShared(city.params);
  const laneOffset = laneOffsetOf(city.params, agent.path.lane);
  // A lane change only makes sense while still on a straight — never halfway round a junction
  // fillet, whose geometry is tied to the lane it was planned for — and only into a lane nothing
  // else is using. A corner that is merely planned (the agent is still on the approach straight and
  // has not switched edges yet) is fine: it is simply re-planned for the new lane below.
  const onStraight =
    !agent.corner.active || (!agent.corner.committed && cornerReference(agent.corner, s.x, s.z, _escapeRef).phase === PHASE_APPROACH);
  // Changing lane gets you around something parked in a lane; it does not get you around something
  // sitting in the middle of a crossing, which every lane's path runs through — that one is passed
  // by aiming off-line instead.
  if (deadAhead && !deadOnCrossing && !headOn && onStraight && offsets.length > 1) {
    for (let lane = 0; lane < offsets.length; lane++) {
      if (lane === agent.path.lane) continue;
      const shift = (offsets[lane] ?? laneOffset) - laneOffset;
      if (!laneIsClear(agent, obstacles, fx, fz, rx, rz, shift)) continue;
      agent.path.lane = lane;
      if (agent.pendingPath) {
        // Anything already planned for the next node was planned for the old lane: re-aim it.
        agent.pendingPath.lane = lane;
        if (agent.corner.active) planCorner(agent.corner, city, edge, agent.path.forward, lane, agent.pendingPath, targetNodeId(edge, agent.path.forward));
      }
      return 0;
    }
  }
  if (!deadAhead && !headOn) return 0;
  return escapeOffset(city.params, laneOffset, deadAhead ? ESCAPE_OFFSET_LANE : ESCAPE_OFFSET);
}

/** Is the strip `shift` metres to the agent's right free of vehicles for a car length either way? */
function laneIsClear(
  agent: TrafficAgent,
  obstacles: readonly TrafficObstacle[],
  fx: number,
  fz: number,
  rx: number,
  rz: number,
  shift: number,
): boolean {
  const s = agent.state;
  for (let i = 0; i < obstacles.length; i++) {
    const ob = obstacles[i]!;
    const odx = ob.x - s.x;
    const odz = ob.z - s.z;
    const along = odx * fx + odz * fz;
    if (Math.abs(along) > LANE_CHANGE_CLEARANCE) continue;
    const lateral = odx * rx + odz * rz;
    if (Math.abs(lateral - shift) < agent.spec.halfWidth + ob.halfWidth + 0.4) return false;
  }
  return true;
}

const _ref = createPathReference();

/** Steer + throttle/brake toward the reference path, slowing for corners, leaders and junctions. */
export function computeTrafficInput(agent: TrafficAgent, city: CityData, obstacles: readonly TrafficObstacle[]): VehicleInput {
  const s = agent.state;
  const edge = city.roads.edges[agent.path.edgeId]!;
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  const rx = -fz;
  const rz = fx;
  const ref = pathReference(agent, city, _ref);
  // Liveness: an agent that has been standing still for a while stops obeying the yield rule and
  // gets itself around whatever is blocking it instead of waiting for ever. Without this, two rules
  // that are each individually correct (yield to whoever is in the junction; never drive into the
  // car in front) can lock two cars against each other for good — nothing in either rule ever
  // changes its mind, and the queues behind them freeze too.
  const escaping = agent.escapeTimer > 0;

  // --- scan obstacles: intersection yield, leader ahead, head-on blocker ------------------------
  const node = city.roads.nodes[targetNodeId(edge, agent.path.forward)]!;
  const boxHalf = city.params.roadWidth / 2 + INTERSECTION_MARGIN;
  const distToNode = Math.hypot(node.x - s.x, node.z - s.z);
  // Only yield once close enough to the junction that creeping forward makes sense — farther out
  // the pre-corner speed cap already handles slowing down.
  const inYieldRange = !escaping && distToNode > boxHalf && distToNode < boxHalf + YIELD_RANGE_MARGIN;
  let yielding = false;
  let leaderGap = Infinity;
  let leaderSpeed = 0;
  /** Whether the current leader is something that will never move on its own (see below). */
  let leaderIsDead = false;
  let oncomingGap = Infinity;
  let behindGap = Infinity;
  for (let i = 0; i < obstacles.length; i++) {
    const ob = obstacles[i]!;
    const obFx = Math.sin(ob.heading);
    const obFz = Math.cos(ob.heading);
    if (inYieldRange && !yielding) {
      const ndx = ob.x - node.x;
      const ndz = ob.z - node.z;
      if (ndx * ndx + ndz * ndz < boxHalf * boxHalf) {
        // Ignore anything already clearing the junction (moving away from its centre).
        const leaving = ob.forwardSpeed * (obFx * ndx + obFz * ndz) > 0.3;
        if (!leaving) yielding = true;
      }
    }
    const odx = ob.x - s.x;
    const odz = ob.z - s.z;
    const along = odx * fx + odz * fz;
    const lateral = odx * rx + odz * rz;
    if (Math.abs(lateral) > LANE_TOLERANCE) continue;
    if (along <= 0) {
      const behind = -along - agent.spec.halfLength - ob.halfLength;
      if (behind < behindGap) behindGap = behind;
      continue;
    }
    const gap = along - agent.spec.halfLength - ob.halfLength;
    if (obFx * fx + obFz * fz < -0.5) {
      // Oncoming: brake for it, but never adopt it as a "leader" whose speed we match — matching a
      // stopped head-on car is a guaranteed mutual deadlock.
      if (gap < oncomingGap) oncomingGap = gap;
      continue;
    }
    if (gap < leaderGap) {
      leaderGap = gap;
      leaderSpeed = ob.forwardSpeed;
      leaderIsDead = isDeadEnd(ob, city, node.x, node.z);
    }
  }
  const blockedHeadOn = oncomingGap < ONCOMING_GAP;
  const blockedDeadEnd = leaderIsDead && leaderGap < FOLLOW_GAP;
  /** Something ahead that waiting cannot clear — the escape steers around it instead of queueing. */
  const blockedDead = blockedHeadOn || blockedDeadEnd;
  // First leg of the escape: back away from a blocker that is close enough to be touching, so the
  // creep-around below has room to actually steer (a car wedged nose to nose cannot move sideways —
  // the steering only bites while the wheels are rolling).
  if (
    escaping &&
    agent.escapeTimer > ESCAPE_DURATION - ESCAPE_REVERSE_TIME &&
    Math.min(oncomingGap, blockedDeadEnd ? leaderGap : Infinity) < ESCAPE_REVERSE_GAP &&
    behindGap > ESCAPE_REVERSE_CLEARANCE
  ) {
    return { throttle: 0, brake: 0.6, steer: 0, handbrake: false };
  }

  // --- steering: track the reference path -------------------------------------------------------
  const refFx = Math.sin(ref.heading);
  const refFz = Math.cos(ref.heading);
  const refRx = -refFz;
  const refRz = refFx;
  // While escaping, aim for the line the manoeuvre picked when it started (`planEscape`): 0 if it
  // changed lane (the reference path already leads around the obstruction), otherwise a sideways
  // offset from the lane the agent is on.
  const bias = escaping && blockedDead ? agent.escapeBias : 0;
  const refX = ref.x + bias * refRx;
  const refZ = ref.z + bias * refRz;
  // Positive = the car is to the right of the reference line (toward the kerb).
  const crossTrackError = (s.x - refX) * refRx + (s.z - refZ) * refRz;
  // Positive = the car's heading has rotated too far left of the reference direction (recall
  // increasing heading turns left here), so it needs a positive (right) steer to bring it back.
  const headingError = wrapAngle(s.heading - ref.heading);
  // Feed-forward (hold the path's own curvature) + Stanley feedback (heading error + a
  // cross-track term that pulls back onto the line, stronger at low speed). The feed-forward term
  // is what lets the car actually *follow* the corner arc instead of chasing it: pure feedback
  // always lags a curve, and a lookahead point on a 5 m radius arc would cut the corner instead.
  const speedForSteer = Math.max(1.5, Math.abs(s.forwardSpeed));
  const desiredWheelAngle =
    Math.atan(agent.spec.wheelBase * ref.steerCurvature) + headingError - Math.atan2(STANLEY_CROSS_GAIN * crossTrackError, speedForSteer);
  const steer = clamp(desiredWheelAngle / agent.spec.maxSteerAngle, -1, 1);

  // --- speed ------------------------------------------------------------------------------------
  const turnSpeed = agent.turnSpeed;
  let targetSpeed = agent.cruiseSpeed;
  if (ref.phase === PHASE_APPROACH) {
    // Physically-motivated braking curve: "the speed from which `turnSpeed` is still reachable
    // braking at TURN_BRAKE_DECEL over the distance left before the fillet".
    const toArc = Math.max(0, ref.arcDistance);
    if (toArc < agent.turnSlowDist) targetSpeed = Math.min(targetSpeed, Math.sqrt(turnSpeed * turnSpeed + 2 * TURN_BRAKE_DECEL * toArc));
  } else if (ref.phase !== PHASE_LANE) {
    targetSpeed = Math.min(targetSpeed, turnSpeed);
  }
  // Don't accelerate back toward cruise while still visibly off the line or misaligned with it
  // (e.g. recovering after being shunted by another car).
  if (Math.abs(crossTrackError) > TURN_HOLD_LATERAL || Math.abs(headingError) > TURN_HOLD_HEADING) targetSpeed = Math.min(targetSpeed, turnSpeed);
  if (yielding) targetSpeed = 0;
  const passing = escaping && blockedDeadEnd;
  if (leaderGap < FOLLOW_GAP) {
    // Join the queue behind a leader, or — when it is something that will never move and the agent
    // has already waited it out — keep rolling at creep speed while the steering reference above
    // takes the car a lane's width around it. No stopping distance is enforced in that case: the
    // point is to get past, and a nudge at 2.5 m/s is resolved by the usual vehicle collision.
    targetSpeed = passing ? Math.min(targetSpeed, CREEP_SPEED) : Math.min(targetSpeed, Math.max(0, leaderSpeed));
  }
  if (!passing && leaderGap < BRAKE_GAP) targetSpeed = 0;
  if (blockedHeadOn) targetSpeed = escaping ? Math.min(targetSpeed, CREEP_SPEED) : 0;

  let throttle = 0;
  let brake = 0;
  const speed = s.forwardSpeed;
  if (targetSpeed <= 0.15) {
    // Let passive rolling/engine-braking resistance hold it at rest; an active brake at zero
    // speed would engage reverse gear (GTA-style hold-to-reverse), which we don't want here.
    if (speed > 0.3) brake = 1;
  } else {
    const err = targetSpeed - speed;
    if (err > 0.15) throttle = clamp01(err / 3);
    // Braking commits fully (rather than ramping proportionally to the error) whenever the agent
    // is above target: a soft/proportional brake settles into a steady trailing error against the
    // ever-falling pre-corner speed cap and never actually closes the gap by the corner.
    else if (err < -0.15) brake = 1;
  }
  return { throttle, brake, steer, handbrake: false };
}

const _releaseRef = createPathReference();

/**
 * Hooks that let another system reuse an agent's lane-following brain with its own routing and its
 * own physics stepping. Both are optional; traffic itself passes neither.
 */
export interface AdvanceAgentOptions {
  /**
   * Choose the edge/lane to take at `nodeId`, having arrived on `arrivalEdgeId`. Defaults to
   * `chooseNextPath` (a random legal turn). `src/ai/Police.ts` passes a chooser that heads for the
   * player instead, which is the whole of a police car's route planning: everything else — lane
   * centrelines, intersection fillets, following/yielding and the deadlock escape — is shared with
   * ordinary traffic, which is what keeps a pursuing car on the road instead of in a building.
   */
  chooseNext?: (agent: TrafficAgent, nodeId: number, arrivalEdgeId: number) => TrafficPath;
  /**
   * Apply `input` to the agent for `dt` (including its own `prev` bookkeeping). Defaults to
   * `stepVehicle` + `resolveVehicleStatic`; `PoliceSystem` passes `VehicleEntity.step` so a police
   * car accumulates visible damage and animates its light bar like any other car.
   */
  step?: (agent: TrafficAgent, input: VehicleInput, dt: number) => void;
}

/**
 * Advance one agent by `dt`: compute its input, step the shared vehicle physics, resolve against
 * static geometry (if a grid is given) and update its path progress, transitioning to the next
 * edge once it reaches the node.
 */
export function advanceTrafficAgent(
  agent: TrafficAgent,
  city: CityData,
  dt: number,
  obstacles: readonly TrafficObstacle[],
  grid?: StaticColliderGrid,
  opts?: AdvanceAgentOptions,
): void {
  Object.assign(agent.prev, agent.state);
  // Decide the next edge (and plan the corner onto it) well before the node, so the agent brakes
  // and starts turning in time instead of discovering the corner once it is already in it.
  if (!agent.pendingPath && !agent.corner.active) {
    const edge0 = city.roads.edges[agent.path.edgeId]!;
    const remaining = edge0.length * (1 - edgeProgress(city, edge0, agent.path.forward, agent.state.x, agent.state.z));
    if (remaining < agent.decisionDist) {
      const nodeId = targetNodeId(edge0, agent.path.forward);
      const next = opts?.chooseNext ? opts.chooseNext(agent, nodeId, edge0.id) : chooseNextPath(city, agent.rng, nodeId, edge0.id, agent.path.lane);
      agent.pendingPath = next;
      planCorner(agent.corner, city, edge0, agent.path.forward, agent.path.lane, next, nodeId);
    }
  }
  // Deadlock bookkeeping (see `computeTrafficInput`): count time stopped, forget it once moving,
  // and trigger a bounded escape manoeuvre when the wait becomes hopeless. If the escape doesn't
  // work the agent simply queues up another one (and `TrafficSystem` eventually recycles it).
  const speedAbs = Math.abs(agent.state.forwardSpeed);
  if (speedAbs < STUCK_SPEED) agent.stuckTime += dt;
  else if (speedAbs > UNSTUCK_SPEED) agent.stuckTime = Math.max(0, agent.stuckTime - dt * 4);
  if (agent.escapeTimer > 0) agent.escapeTimer = Math.max(0, agent.escapeTimer - dt);
  else if (agent.stuckTime > STUCK_ESCAPE_TIME) {
    agent.escapeTimer = ESCAPE_DURATION;
    agent.stuckTime = 0;
    agent.escapeBias = planEscape(agent, city, obstacles);
  }

  const input = computeTrafficInput(agent, city, obstacles);
  if (opts?.step) {
    opts.step(agent, input, dt);
  } else {
    stepVehicle(agent.state, agent.spec, input, dt);
    if (grid) resolveVehicleStatic(agent.state, agent.spec, grid);
  }

  let edge = city.roads.edges[agent.path.edgeId]!;
  let t = edgeProgress(city, edge, agent.path.forward, agent.state.x, agent.state.z);
  // Commit to the next edge once the agent reaches the fillet's entry tangent (it is on the corner
  // from there on, so the bookkeeping may as well follow), or — with no corner to turn, i.e. a
  // straight-through continuation — simply once it is at the node. A fixed pre-node distance alone
  // is not enough: a right turn's fillet never gets closer than `laneOffset` to the node along the
  // old edge, so on the outer lane the agent would drive off down the new road still believing it
  // was on the old one.
  const reachedCorner =
    agent.corner.active && !agent.corner.committed && cornerReference(agent.corner, agent.state.x, agent.state.z, _releaseRef).phase !== PHASE_APPROACH;
  if (reachedCorner || (!agent.corner.active && edge.length * (1 - t) < NODE_SWITCH_DIST)) {
    const nodeId = targetNodeId(edge, agent.path.forward);
    const oldHeading = lanePoint(city, edge, 1, agent.path.forward, agent.path.lane).heading;
    // Commit to the path decided in advance above; only decide now as a fallback (e.g. an agent
    // spawned within NODE_SWITCH_DIST of its very first node, before ever having a chance to).
    let nextPath = agent.pendingPath;
    if (!nextPath) {
      nextPath = opts?.chooseNext ? opts.chooseNext(agent, nodeId, edge.id) : chooseNextPath(city, agent.rng, nodeId, edge.id, agent.path.lane);
      planCorner(agent.corner, city, edge, agent.path.forward, agent.path.lane, nextPath, nodeId);
    }
    const nextEdge = city.roads.edges[nextPath.edgeId]!;
    const newHeading = lanePoint(city, nextEdge, 0, nextPath.forward, nextPath.lane).heading;
    const turnAngle = wrapAngle(newHeading - oldHeading);
    agent.turnAngle = Math.abs(turnAngle) > TURN_HEADING_THRESHOLD ? turnAngle : 0;
    agent.path = nextPath;
    agent.pendingPath = null;
    agent.corner.committed = true;
    edge = nextEdge;
    t = edgeProgress(city, edge, agent.path.forward, agent.state.x, agent.state.z);
  }
  // The fillet stays the reference across the edge switch (that continuity is the whole point);
  // retire it only once the agent is safely back on the new lane's straight.
  if (agent.corner.active) {
    const ref = cornerReference(agent.corner, agent.state.x, agent.state.z, _releaseRef);
    if (ref.phase === PHASE_EXIT && ref.arcDistance > CORNER_RELEASE_DIST) agent.corner.active = false;
  }
  agent.path.t = clamp01(t);
}

export interface TrafficPopulationOptions {
  grid?: StaticColliderGrid;
  /** Extra obstacles for following/yielding (e.g. parked/player cars), not part of `agents`. */
  extraObstacles?: readonly TrafficObstacle[];
  /** Extra vehicles to physically separate agents from (e.g. parked/player cars). */
  extraVehicles?: readonly { state: VehicleState; spec: VehicleSpec }[];
  /** Only obstacles/pairs within this distance (m) are considered (broad-phase cutoff). */
  interactionRadius?: number;
  /**
   * Reused scratch buffer for the per-agent obstacle list passed to `computeTrafficInput`; when
   * supplied (as `TrafficSystem` does), this avoids allocating a fresh array/objects for every
   * agent pair every tick. Safe to omit (a fresh array is used instead) — tests do.
   */
  scratch?: TrafficObstacle[];
  /**
   * Called whenever an agent's physical separation against one of `extraVehicles` produces a
   * non-trivial impulse (m/s of closing speed removed), with the index into `extraVehicles`. Used
   * by `Game` to detect the player ramming a moving traffic car for the wanted system, without
   * `TrafficSystem` needing to know anything about wanted levels itself.
   */
  onVehicleImpact?: (impulse: number, vehicleIndex: number) => void;
}

const EMPTY_OBSTACLES: readonly TrafficObstacle[] = [];
const EMPTY_VEHICLES: readonly { state: VehicleState; spec: VehicleSpec }[] = [];

/**
 * Advance a whole population for one fixed step: builds each agent's obstacle list from the other
 * agents (+ any extra obstacles), then physically separates nearby overlapping vehicles.
 */
export function stepTrafficPopulation(agents: readonly TrafficAgent[], city: CityData, dt: number, opts: TrafficPopulationOptions = {}): void {
  const extraObstacles = opts.extraObstacles ?? EMPTY_OBSTACLES;
  const extraVehicles = opts.extraVehicles ?? EMPTY_VEHICLES;
  const radius = opts.interactionRadius ?? 30;
  const radius2 = radius * radius;
  // Refresh each agent's persistent obstacle view once (O(n), no allocation: same objects reused
  // by every other agent that considers it below, instead of building a fresh one per pair).
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    a.obstacle.x = a.state.x;
    a.obstacle.z = a.state.z;
    a.obstacle.heading = a.state.heading;
    a.obstacle.forwardSpeed = a.state.forwardSpeed;
  }
  const scratch = opts.scratch ?? [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    let n = 0;
    for (let k = 0; k < extraObstacles.length; k++) scratch[n++] = extraObstacles[k]!;
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      const other = agents[j]!;
      const dx = other.state.x - agent.state.x;
      const dz = other.state.z - agent.state.z;
      if (dx * dx + dz * dz > radius2) continue;
      scratch[n++] = other.obstacle;
    }
    scratch.length = n;
    advanceTrafficAgent(agent, city, dt, scratch, opts.grid);
  }
  // Physical separation: nearby agent pairs, and agents vs any extra vehicles (e.g. parked/player cars).
  const collideDist2 = 8 * 8;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j]!;
      const dx = a.state.x - b.state.x;
      const dz = a.state.z - b.state.z;
      if (dx * dx + dz * dz > collideDist2) continue;
      resolveVehicleVehicle(a.state, a.spec, b.state, b.spec);
    }
    for (let k = 0; k < extraVehicles.length; k++) {
      const ev = extraVehicles[k]!;
      const dx = a.state.x - ev.state.x;
      const dz = a.state.z - ev.state.z;
      if (dx * dx + dz * dz > collideDist2) continue;
      const impact = resolveVehicleVehicle(a.state, a.spec, ev.state, ev.spec);
      if (impact && impact.impulse > 0) opts.onVehicleImpact?.(impact.impulse, k);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Rendering: a thin, pooled three.js layer
// -----------------------------------------------------------------------------------------------

/** Build the merged, six-material traffic car geometry once (shared by every pooled instance). */
function buildTrafficGeometry(spec: VehicleSpec): BufferGeometry {
  const hw = spec.halfWidth;
  const hl = spec.halfLength;
  const wr = spec.wheelRadius;
  const ground = wr;

  const mergeBucket = (parts: BufferGeometry[]): BufferGeometry => {
    const merged = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    return merged;
  };

  const paint = mergeBucket([
    new BoxGeometry(hw * 2, 0.62, hl * 2).translate(0, ground + 0.31, 0),
    new BoxGeometry(hw * 2 - 0.18, 0.28, hl * 2 - 0.5).translate(0, ground + 0.76, -0.05),
    new BoxGeometry(hw * 2 - 0.42, 0.06, hl * 1.0).translate(0, ground + 1.43, -0.35),
  ]);
  const glass = mergeBucket([new BoxGeometry(hw * 2 - 0.38, 0.5, hl * 1.05).translate(0, ground + 1.15, -0.35)]);
  const trim = mergeBucket([
    new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18).translate(0, ground + 0.2, hl - 0.02),
    new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18).translate(0, ground + 0.2, -hl + 0.02),
    new BoxGeometry(hw * 0.9, 0.18, 0.06).translate(0, ground + 0.5, hl + 0.01),
  ]);
  const wheelGeo = new CylinderGeometry(wr, wr, 0.26, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const axleZ = spec.wheelBase / 2;
  const rubberParts: BufferGeometry[] = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as [number, number][]) {
    rubberParts.push(wheelGeo.clone().translate(sx * (hw - 0.05), wr, sz * axleZ));
  }
  wheelGeo.dispose();
  const rubber = mergeBucket(rubberParts);
  const headParts: BufferGeometry[] = [];
  const tailParts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    headParts.push(new BoxGeometry(0.34, 0.16, 0.06).translate(side * (hw - 0.3), ground + 0.56, hl + 0.01));
    tailParts.push(new BoxGeometry(0.34, 0.14, 0.06).translate(side * (hw - 0.3), ground + 0.56, -hl - 0.01));
  }
  const headlight = mergeBucket(headParts);
  const taillight = mergeBucket(tailParts);

  // One group per bucket (materialIndex 0..5), matching the material array built in `TrafficSystem`.
  const buckets = [paint, glass, trim, rubber, headlight, taillight];
  const merged = mergeGeometries(buckets, true)!;
  for (const b of buckets) b.dispose();
  merged.computeBoundingSphere();
  return merged;
}

interface SharedMaterials {
  glass: MeshPhysicalMaterial;
  trim: MeshStandardMaterial;
  rubber: MeshStandardMaterial;
  headlight: MeshStandardMaterial;
  taillight: MeshStandardMaterial;
}

function buildSharedMaterials(registry: MaterialRegistry): SharedMaterials {
  return {
    glass: registry.register(new MeshPhysicalMaterial({ color: 0x0b1016, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.72 })),
    trim: registry.register(new MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.6, metalness: 0.3 })),
    rubber: registry.register(new MeshStandardMaterial({ color: 0x111214, roughness: 0.9, metalness: 0 })),
    headlight: registry.register(new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(0xfff6df), emissiveIntensity: 0, roughness: 0.3 })),
    taillight: registry.register(new MeshStandardMaterial({ color: 0x550000, emissive: new Color(0xff2a1a), emissiveIntensity: 0.2, roughness: 0.4 })),
  };
}

/** Keep spawns at least this far (m) from either end of an edge (i.e. out of the junctions). */
const SPAWN_NODE_MARGIN = 16;
/**
 * Last-resort liveness: an agent still wedged after this long (s) — boxed in by the player's car,
 * shunted onto a kerb, jammed nose to nose in a corner — is recycled instead of sitting there for
 * ever, but only well away from the focus so the pop is never visible.
 */
const STUCK_RECYCLE_TIME = 12;
const STUCK_RECYCLE_DIST = 45;

interface PoolSlot {
  group: Group;
  mesh: Mesh;
  paint: MeshPhysicalMaterial;
  agent: TrafficAgent | null;
}

export interface TrafficFocus {
  x: number;
  z: number;
  heading: number;
}

/** Owns a fixed-size pool of pooled car meshes and the AI agents driving them. */
export class TrafficSystem {
  readonly object = new Group();
  private slots: PoolSlot[] = [];
  /** Active agents, kept in sync with `slots` on spawn/despawn (avoids rebuilding this every tick). */
  private agents: TrafficAgent[] = [];
  /** One merged geometry per catalog type, sized to that type's spec (halfWidth/halfLength/wheelRadius/wheelBase). */
  private geometries: Map<VehicleType, BufferGeometry> | null = null;
  private shared: SharedMaterials | null = null;
  private readonly rng: Random;
  private nextId = 1;
  private spawnRadius: number;
  private readonly despawnMargin = 60;
  private readonly minSpawnDist = 24;
  private readonly minSeparation = 10;
  /** Reused scratch buffer for `stepTrafficPopulation`'s per-agent obstacle list (no per-tick allocation). */
  private readonly scratchObstacles: TrafficObstacle[] = [];
  /** Reused, index-aligned `TrafficObstacle` view of the extra vehicles passed to `update()`. */
  private extraObstacleCache: TrafficObstacle[] = [];
  /**
   * Persistent view of every active agent as a `TrafficObstacle`, refreshed after each `update()`
   * (post-step, so positions are current) so other systems — pedestrians reacting to traffic — can
   * read it with no per-tick allocation of their own.
   */
  private readonly obstacleView: TrafficObstacle[] = [];

  constructor(
    private readonly city: CityData,
    private readonly registry: MaterialRegistry,
    quality: QualitySettings,
    seed: number,
    focus: TrafficFocus,
  ) {
    this.object.name = 'traffic';
    this.rng = new Random(seed ^ 0x7a2f11);
    this.spawnRadius = quality.drawDistance;
    this.rebuild(quality, focus);
  }

  /** Resize the pool for a new quality preset and refill it near `focus` (called on quality change). */
  rebuild(quality: QualitySettings, focus: TrafficFocus): void {
    this.disposePool();
    this.spawnRadius = quality.drawDistance;
    const geometries = new Map<VehicleType, BufferGeometry>();
    for (const t of VEHICLE_TYPES) geometries.set(t, buildTrafficGeometry(resolveVehicleSpec(t)));
    this.geometries = geometries;
    this.shared = buildSharedMaterials(this.registry);
    // Gated on the actual shadow mode (not the preset name) so a 'custom' preset derived from low
    // via q.* overrides doesn't accidentally cast shadows; 'single' (low's cheap shadow mode) skips
    // traffic shadows for cost since the fleet is much larger than the handful of parked cars.
    const castShadow = quality.shadows === 'csm';
    const count = Math.max(0, quality.maxTraffic);
    for (let i = 0; i < count; i++) this.slots.push(this.createSlot(castShadow));
    // Fill up to capacity right away so the population doesn't visibly trickle in after a rebuild.
    let guard = count * 8;
    while (guard-- > 0 && this.slots.some((s) => !s.agent)) {
      if (!this.trySpawn(focus)) break;
    }
  }

  private createSlot(castShadow: boolean): PoolSlot {
    const paint = this.registry.register(new MeshPhysicalMaterial({ metalness: 0.6, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.2 }));
    const shared = this.shared!;
    // Placeholder geometry (sedan); trySpawn() swaps it to the spawned agent's own type each time.
    const mesh = new Mesh(this.geometries!.get('sedan')!, [paint, shared.glass, shared.trim, shared.rubber, shared.headlight, shared.taillight]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    const group = new Group();
    group.add(mesh);
    group.visible = false;
    this.object.add(group);
    return { group, mesh, paint, agent: null };
  }

  private trySpawn(focus: TrafficFocus): boolean {
    const free = this.slots.find((s) => !s.agent);
    if (!free) return false;
    const edges = this.city.roads.edges;
    if (edges.length === 0) return false;
    // Traffic uses every lane on its own side of the road (0 = inner, 1 = outer on the default
    // 14 m road): the intersection fillet is built for whatever lane offset the agent is on.
    const laneCount = laneOffsetsShared(this.city.params).length;
    const fx = Math.sin(focus.heading);
    const fz = Math.cos(focus.heading);
    let fallback: { path: TrafficPath; x: number; z: number; heading: number } | null = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const edge = edges[this.rng.int(0, edges.length - 1)]!;
      const forward = this.rng.chance(0.5);
      const lane = this.rng.int(0, laneCount - 1);
      // Keep clear of both nodes: a car dropped mid-junction would start already inside a corner
      // it never approached, at full cruise speed.
      const margin = Math.min(0.4, SPAWN_NODE_MARGIN / edge.length);
      const t = this.rng.range(margin, 1 - margin);
      const lp = lanePoint(this.city, edge, t, forward, lane);
      const d = Math.hypot(lp.x - focus.x, lp.z - focus.z);
      if (d < this.minSpawnDist || d > this.spawnRadius) continue;
      let clear = true;
      for (const s of this.slots) {
        if (!s.agent) continue;
        if (Math.hypot(s.agent.state.x - lp.x, s.agent.state.z - lp.z) < this.minSeparation) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const candidate = { path: { edgeId: edge.id, forward, lane, t }, x: lp.x, z: lp.z, heading: lp.heading };
      // Prefer a spot roughly behind/beside the focus (out of view) when one is available.
      const behind = (lp.x - focus.x) * fx + (lp.z - focus.z) * fz < 0.2 * d;
      if (behind) {
        fallback = candidate;
        break;
      }
      if (!fallback) fallback = candidate;
    }
    if (!fallback) return false;
    const cruiseSpeed = this.rng.range(6, 12);
    const id = this.nextId++;
    const type = pickVehicleType(this.rng);
    const spec = resolveVehicleSpec(type);
    const agent = createTrafficAgent(id, this.city, fallback.path, this.rng.fork(`traffic-agent:${id}`), cruiseSpeed, spec);
    free.agent = agent;
    free.mesh.geometry = this.geometries!.get(type)!;
    free.paint.color.set(pickVehiclePaint(this.rng, type));
    free.group.visible = true;
    free.group.position.set(agent.state.x, 0, agent.state.z);
    free.group.rotation.set(0, agent.state.heading, 0);
    this.agents.push(agent);
    return true;
  }

  private despawn(slot: PoolSlot): void {
    const agent = slot.agent;
    if (agent) {
      const idx = this.agents.indexOf(agent);
      if (idx >= 0) {
        // Swap-remove: O(1), agent order doesn't matter.
        const last = this.agents.length - 1;
        this.agents[idx] = this.agents[last]!;
        this.agents.length = last;
      }
    }
    slot.agent = null;
    slot.group.visible = false;
  }

  /**
   * Fixed-step update: despawn agents beyond range, spawn to refill, then advance the population.
   * `vehicles` is every vehicle (parked and, if driven, the player's) to follow/yield to and
   * physically resolve against — pass a persistent, reused array (Game keeps one; the entries'
   * `state` objects are mutated in place, so no per-tick allocation is needed there either).
   */
  update(
    dt: number,
    focus: TrafficFocus,
    grid: StaticColliderGrid,
    vehicles: readonly { state: VehicleState; spec: VehicleSpec }[],
    onVehicleImpact?: (impulse: number, vehicleIndex: number) => void,
  ): void {
    const despawnAt = this.spawnRadius + this.despawnMargin;
    for (const slot of this.slots) {
      const agent = slot.agent;
      if (!agent) continue;
      const d = Math.hypot(agent.state.x - focus.x, agent.state.z - focus.z);
      if (d > despawnAt || (agent.stuckTime > STUCK_RECYCLE_TIME && d > STUCK_RECYCLE_DIST)) this.despawn(slot);
    }
    // Refill gradually (a handful per tick) rather than all at once to avoid spawn pop-in bursts.
    for (let i = 0; i < 3; i++) {
      if (!this.trySpawn(focus)) break;
    }
    // Keep a persistent, index-aligned TrafficObstacle view of `vehicles`, refreshed in place —
    // rebuilt only if the vehicle count itself changes (it doesn't, in practice, after spawn).
    if (this.extraObstacleCache.length !== vehicles.length) {
      this.extraObstacleCache = vehicles.map((v) => obstacleFromVehicle(v.state, v.spec, true));
    }
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]!;
      const ob = this.extraObstacleCache[i]!;
      ob.x = v.state.x;
      ob.z = v.state.z;
      ob.heading = v.state.heading;
      ob.forwardSpeed = v.state.forwardSpeed;
    }
    stepTrafficPopulation(this.agents, this.city, dt, {
      grid,
      extraObstacles: this.extraObstacleCache,
      extraVehicles: vehicles,
      scratch: this.scratchObstacles,
      onVehicleImpact,
    });
    // Refresh the exposed obstacle view post-step (stepTrafficPopulation's own refresh happens
    // before each agent moves, for internal consistency — see stepTrafficPopulation's comment).
    this.obstacleView.length = this.agents.length;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i]!;
      a.obstacle.x = a.state.x;
      a.obstacle.z = a.state.z;
      a.obstacle.heading = a.state.heading;
      a.obstacle.forwardSpeed = a.state.forwardSpeed;
      this.obstacleView[i] = a.obstacle;
    }
  }

  /** Every active traffic agent as a `TrafficObstacle` (post-step positions), for systems that need
   *  to react to traffic without depending on `TrafficSystem`'s own agent/pool internals. */
  get obstacles(): readonly TrafficObstacle[] {
    return this.obstacleView;
  }

  /** Interpolate every active pooled car between its previous and current physics state. */
  syncVisual(alpha: number): void {
    const a = clamp01(alpha);
    for (const slot of this.slots) {
      const agent = slot.agent;
      if (!agent) continue;
      const s = agent.state;
      const p = agent.prev;
      const x = p.x + (s.x - p.x) * a;
      const z = p.z + (s.z - p.z) * a;
      const heading = p.heading + wrapAngle(s.heading - p.heading) * a;
      slot.group.position.set(x, 0, z);
      slot.group.rotation.set(0, heading, 0);
    }
  }

  setLights(on: boolean): void {
    if (!this.shared) return;
    this.shared.headlight.emissiveIntensity = on ? 4 : 0;
    this.shared.taillight.emissiveIntensity = on ? 2.5 : 0.2;
  }

  /** Snapshot for debugging / e2e assertions. */
  get stats(): { agents: number; moving: number; list: { id: number; x: number; z: number; speed: number }[] } {
    const list = this.slots
      .filter((s) => s.agent)
      .map((s) => ({ id: s.agent!.id, x: s.agent!.state.x, z: s.agent!.state.z, speed: s.agent!.state.forwardSpeed }));
    const moving = list.filter((a) => Math.abs(a.speed) > 0.5).length;
    return { agents: list.length, moving, list };
  }

  private disposePool(): void {
    for (const slot of this.slots) {
      this.registry.unregister(slot.paint);
      slot.paint.dispose();
      slot.group.clear();
      slot.group.removeFromParent();
    }
    this.slots = [];
    this.agents = [];
    if (this.geometries) {
      for (const g of this.geometries.values()) g.dispose();
      this.geometries = null;
    }
    if (this.shared) {
      for (const m of Object.values(this.shared)) {
        this.registry.unregister(m);
        m.dispose();
      }
      this.shared = null;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.disposePool();
  }
}
