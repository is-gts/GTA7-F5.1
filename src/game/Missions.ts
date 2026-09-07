/**
 * Missions: pure state machine (no three.js) for checkpoint races and delivery jobs discovered in
 * the world, plus deterministic generation of their start/checkpoint positions from the city's road
 * graph. `Game` drives it from vehicle position each tick (start on driving into the start marker,
 * advance on reaching a checkpoint) and from timers (timeout, wrecking the car, leaving it too long
 * during a race).
 *
 * No `Math.random()` — everything is a pure function of a `Random` instance (see `world/Random.ts`)
 * or of the state passed in, exactly like `Wanted.ts` and `Weather.ts`, so this is fully
 * unit-testable and Game.simulate() stays deterministic.
 */
import { Random } from '../world/Random';
import { laneOffsetsShared, lanePoint, type CityData, type RoadEdge } from '../world/CityGenerator';

export type MissionType = 'race' | 'delivery';
export type MissionStatus = 'available' | 'active' | 'complete' | 'failed';

export interface MissionPoint {
  x: number;
  z: number;
}

export interface MissionDef {
  id: string;
  type: MissionType;
  /** Where driving a vehicle into the start marker begins the mission. */
  start: MissionPoint;
  /** Ordered checkpoints after the start. For a race, the finish sequence (reach every one in
   *  order). For a delivery, exactly two: `checkpoints[0]` is the pickup, `checkpoints[1]` the
   *  dropoff. */
  checkpoints: MissionPoint[];
  /** Money paid on completion. */
  reward: number;
  /** Seconds allowed from start to completion before the mission times out. */
  timeLimit: number;
}

export interface MissionRuntime {
  status: MissionStatus;
  /** Index into `def.checkpoints` of the next checkpoint to reach. Equals `checkpoints.length`
   *  only transiently, in the tick a mission completes. */
  checkpointIndex: number;
  /** Seconds left before the active mission times out. */
  timeRemaining: number;
  /** Consecutive seconds (race missions only) the player has been out of the vehicle while active. */
  outOfVehicleTime: number;
  /** Seconds left before a `'failed'` mission returns to `'available'` (0 otherwise). `'failed'` is
   *  only a brief, transient status for the HUD toast — see `reviveFailedMissions`. */
  retryCooldown: number;
}

export interface MissionsState {
  defs: readonly MissionDef[];
  /** `def.id -> runtime`, one entry per def, always present (built by `createMissionsState`). */
  runtime: Readonly<Record<string, MissionRuntime>>;
  /** The one mission that can be `'active'` at a time, or `null`. */
  activeId: string | null;
  money: number;
  /** Ids of every mission ever completed (persisted; used to restore `'complete'` status on load). */
  completedIds: readonly string[];
}

/** Body-to-body radius (m) within which driving into a start marker or checkpoint counts as reached. */
export const CHECKPOINT_RADIUS = 7;
/** Minimum straight-line separation (m) enforced between consecutive generated points. */
export const MIN_CHECKPOINT_SPACING = 60;
/** Maximum straight-line separation (m) allowed between consecutive generated points. Without this,
 *  picking uniformly from the whole road network occasionally chains points hundreds of metres
 *  apart across a large city, turning a "checkpoint race" into a cross-town transit with a handful
 *  of corners — this keeps each leg local, like a real point-to-point street race. Paired with
 *  `MIN_CHECKPOINT_SPACING` below as the lower bound. */
export const MAX_CHECKPOINT_SPACING = 220;
/** Minimum distance (m) enforced between *any* two generated mission points, across missions as
 *  well as within one. Two markers closer than this would render as overlapping columns, and — worse
 *  — completing one mission on top of another's start marker would instantly auto-start that one.
 *  Comfortably larger than the `CHECKPOINT_RADIUS` trigger circles themselves (which are 2 *
 *  `CHECKPOINT_RADIUS` = 14 m across in the worst case) so the trigger circles stay disjoint too. */
export const MIN_POINT_SEPARATION = 3 * CHECKPOINT_RADIUS;
/** Number of ordered checkpoints generated for a race mission. */
export const RACE_CHECKPOINT_COUNT = 4;
/** Consecutive seconds out of the vehicle during an active race before it fails. */
export const OUT_OF_VEHICLE_FAIL_TIME = 10;
/** Default number of mission definitions generated per city. */
export const DEFAULT_MISSION_COUNT = 6;
/** Seconds a `'failed'` mission stays failed (enough for the HUD toast to read) before its start
 *  marker reappears and it can be attempted again — see `reviveFailedMissions`. */
export const FAILED_RETRY_COOLDOWN = 3;

const RACE_REWARD = 250;
const DELIVERY_REWARD = 180;
/**
 * Sustained average speed (m/s, ~50 km/h) a `timeLimit` is budgeted against, driving along the road
 * grid (Manhattan distance, not straight-line — the city has no diagonal streets). Comfortably below
 * even the slowest catalog vehicle's top speed (the van, 40 m/s — see `entities/VehicleCatalog.ts`),
 * so a route is always achievable while turns, traffic and braking eat into the average.
 */
const TARGET_AVG_SPEED = 14;
/** Extra seconds of slack per checkpoint (turning, slowing, weaving through traffic at each stop). */
const PER_CHECKPOINT_TIME = 10;
/** Floor so even the shortest possible route (one min-spacing leg) leaves a fair amount of time. */
const MIN_TIME_LIMIT = 30;
/** Bounded retries for `nextPoint` below — generous since this runs once at city load, not per tick. */
const SPACING_MAX_TRIES = 200;

// -----------------------------------------------------------------------------------------------
// Generation (pure, deterministic given `city` + `seed`).
// -----------------------------------------------------------------------------------------------

/** A point on `edge`, offset onto a real travel lane (so it always lands within `roadWidth/2` of
 *  its edge's centreline, like any other lane position in the game). */
function pointOnEdge(city: CityData, edge: RoadEdge, rng: Random): MissionPoint {
  const t = rng.range(0.15, 0.85);
  const forward = rng.chance(0.5);
  const lanes = laneOffsetsShared(city.params).length;
  const lane = rng.int(0, Math.max(0, lanes - 1));
  const lp = lanePoint(city, edge, t, forward, lane);
  return { x: lp.x, z: lp.z };
}

/** Distance (m) from `p` to the nearest already-placed mission point, or `Infinity` when none. */
function distanceToOccupied(p: MissionPoint, occupied: readonly MissionPoint[]): number {
  let best = Infinity;
  for (const o of occupied) best = Math.min(best, Math.hypot(p.x - o.x, p.z - o.z));
  return best;
}

/** A uniformly-random point on the road network at least `MIN_POINT_SEPARATION` from every point in
 *  `occupied` (used only for a mission's `start`, which may sit anywhere in the city). Retries a
 *  bounded number of times and otherwise falls back to the candidate furthest from `occupied`, so
 *  this always terminates even in a city too small to hold every mission comfortably apart. */
function randomRoadPoint(city: CityData, rng: Random, occupied: readonly MissionPoint[]): MissionPoint {
  let best: MissionPoint | null = null;
  let bestClearance = -Infinity;
  for (let i = 0; i < SPACING_MAX_TRIES; i++) {
    const p = pointOnEdge(city, rng.pick(city.roads.edges), rng);
    const clearance = distanceToOccupied(p, occupied);
    if (clearance >= MIN_POINT_SEPARATION) return p;
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = p;
    }
  }
  return best!;
}

/** Edges whose midpoint lies within `maxDist` of `p` (padded by half the edge's own length, so an
 *  edge that starts just inside range but runs on past it is still eligible) — keeps consecutive
 *  checkpoints local (see `MAX_CHECKPOINT_SPACING`) instead of picking from the whole city. */
function edgesNear(city: CityData, p: MissionPoint, maxDist: number): RoadEdge[] {
  const out: RoadEdge[] = [];
  for (const edge of city.roads.edges) {
    const a = city.roads.nodes[edge.a]!;
    const b = city.roads.nodes[edge.b]!;
    const midX = (a.x + b.x) / 2;
    const midZ = (a.z + b.z) / 2;
    if (Math.hypot(midX - p.x, midZ - p.z) <= maxDist + edge.length / 2) out.push(edge);
  }
  return out;
}

/**
 * A random road point between `minDist` and `maxDist` from `prev` and at least
 * `MIN_POINT_SEPARATION` from every already-placed point in `occupied`, picked among edges near
 * `prev` (not the whole road network — see `MAX_CHECKPOINT_SPACING`). Retries up to
 * `SPACING_MAX_TRIES` times; if nothing satisfies both constraints it falls back to the best
 * candidate found — preferring one that at least respects the leg-length range (a marker a little
 * too close to another is a cosmetic annoyance, a 500 m leg is a broken mission) — so this always
 * terminates.
 */
function nextPoint(
  city: CityData,
  rng: Random,
  prev: MissionPoint,
  occupied: readonly MissionPoint[],
  minDist = MIN_CHECKPOINT_SPACING,
  maxDist = MAX_CHECKPOINT_SPACING,
): MissionPoint {
  const nearby = edgesNear(city, prev, maxDist);
  const pool = nearby.length > 0 ? nearby : city.roads.edges; // tiny-city fallback: nothing in range
  let inRange: MissionPoint | null = null;
  let inRangeClearance = -Infinity;
  let best = prev;
  let bestScore = Infinity;
  for (let i = 0; i < SPACING_MAX_TRIES; i++) {
    const p = pointOnEdge(city, rng.pick(pool), rng);
    const d = Math.hypot(p.x - prev.x, p.z - prev.z);
    const clearance = distanceToOccupied(p, occupied);
    if (d >= minDist && d <= maxDist) {
      if (clearance >= MIN_POINT_SEPARATION) return p;
      if (clearance > inRangeClearance) {
        inRangeClearance = clearance;
        inRange = p;
      }
      continue;
    }
    const score = d < minDist ? minDist - d : d - maxDist;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return inRange ?? best;
}

/** Actual driving distance (m) between two points on the road grid: there are no diagonal streets,
 *  so a straight-line distance would understate it — this is what `computeTimeLimit` budgets a
 *  mission's timer against. */
function manhattanDistance(a: MissionPoint, b: MissionPoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
}

/** Timer (s) for a mission whose start-then-checkpoints sequence is `points`: driving distance over
 *  `TARGET_AVG_SPEED` plus `PER_CHECKPOINT_TIME` slack per checkpoint, floored at `MIN_TIME_LIMIT` —
 *  scales with the actually-generated route instead of a fixed constant, so it stays achievable
 *  regardless of how far apart `generateMissions` happens to place this mission's points. */
function computeTimeLimit(points: readonly MissionPoint[], checkpointCount: number): number {
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += manhattanDistance(points[i - 1]!, points[i]!);
  const raw = dist / TARGET_AVG_SPEED + checkpointCount * PER_CHECKPOINT_TIME;
  return Math.max(MIN_TIME_LIMIT, Math.round(raw));
}

/**
 * Generate `count` mission definitions (alternating race/delivery) from `city`'s road graph. Pure
 * and deterministic: the same `city` + `seed` always yields byte-identical results, so it is safe to
 * call once at load and to unit-test directly.
 */
export function generateMissions(city: CityData, seed: number | string, count = DEFAULT_MISSION_COUNT): MissionDef[] {
  const rng = new Random(seed);
  const defs: MissionDef[] = [];
  // Every point placed so far, across all missions: each new one keeps `MIN_POINT_SEPARATION` from
  // all of them, so no two marker columns overlap and completing one mission can never dump the
  // player straight inside another's start trigger.
  const occupied: MissionPoint[] = [];
  for (let i = 0; i < count; i++) {
    const mrng = rng.fork(`mission:${i}`);
    const type: MissionType = i % 2 === 0 ? 'race' : 'delivery';
    const start = randomRoadPoint(city, mrng, occupied);
    occupied.push(start);
    const checkpointCount = type === 'race' ? RACE_CHECKPOINT_COUNT : 2;
    const checkpoints: MissionPoint[] = [];
    let prev = start;
    for (let c = 0; c < checkpointCount; c++) {
      const p = nextPoint(city, mrng, prev, occupied);
      checkpoints.push(p);
      occupied.push(p);
      prev = p;
    }
    defs.push({
      id: `${type}-${i}`,
      type,
      start,
      checkpoints,
      reward: type === 'race' ? RACE_REWARD : DELIVERY_REWARD,
      timeLimit: computeTimeLimit([start, ...checkpoints], checkpoints.length),
    });
  }
  return defs;
}

// -----------------------------------------------------------------------------------------------
// State machine.
// -----------------------------------------------------------------------------------------------

/** Fresh runtime state for one mission: not yet completed (see `createMissionsState`). */
function freshRuntime(def: MissionDef): MissionRuntime {
  return { status: 'available', checkpointIndex: 0, timeRemaining: def.timeLimit, outOfVehicleTime: 0, retryCooldown: 0 };
}

/** Build the initial `MissionsState` for `defs`, restoring `'complete'` status (and `money`) from a
 *  save (see `loadMissionsSave`). Unknown ids in `completedIds` (e.g. from a stale save after the
 *  mission set changed) are dropped rather than kept as dead weight. */
export function createMissionsState(defs: readonly MissionDef[], money = 0, completedIds: readonly string[] = []): MissionsState {
  const known = new Set(defs.map((d) => d.id));
  const completed = completedIds.filter((id) => known.has(id));
  const completedSet = new Set(completed);
  const runtime: Record<string, MissionRuntime> = {};
  for (const def of defs) {
    runtime[def.id] = completedSet.has(def.id) ? { ...freshRuntime(def), status: 'complete' } : freshRuntime(def);
  }
  return { defs, runtime, activeId: null, money, completedIds: completed };
}

function defOf(state: MissionsState, id: string): MissionDef {
  const def = state.defs.find((d) => d.id === id);
  if (!def) throw new Error(`unknown mission id: ${id}`);
  return def;
}

/** The current target the player must drive into to progress `id`'s mission, or `null` once it has
 *  no more checkpoints left (should not normally be observed — `advanceCheckpoint` completes the
 *  mission on the last one). */
export function checkpointTarget(state: MissionsState, id: string): MissionPoint | null {
  const def = defOf(state, id);
  const r = state.runtime[id];
  if (!r) return null;
  return def.checkpoints[r.checkpointIndex] ?? null;
}

/** The active mission's current checkpoint target, or `null` if no mission is active. */
export function activeCheckpoint(state: MissionsState): MissionPoint | null {
  return state.activeId ? checkpointTarget(state, state.activeId) : null;
}

/** Begin mission `id`: only takes effect while it is `'available'` and no other mission is active
 *  (one active mission at a time). Resets its timer/checkpoint bookkeeping fresh. */
export function startMission(state: MissionsState, id: string): MissionsState {
  if (state.activeId !== null) return state;
  const r = state.runtime[id];
  if (!r || r.status !== 'available') return state;
  const def = defOf(state, id);
  const runtime = { ...state.runtime, [id]: { status: 'active' as const, checkpointIndex: 0, timeRemaining: def.timeLimit, outOfVehicleTime: 0, retryCooldown: 0 } };
  return { ...state, runtime, activeId: id };
}

/** Reached the current checkpoint of the active mission `id`: advances to the next one, or —  on the
 *  last checkpoint — completes the mission and pays `def.reward` into `money`. No-op unless `id` is
 *  the currently active mission. */
export function advanceCheckpoint(state: MissionsState, id: string): MissionsState {
  const r = state.runtime[id];
  if (!r || r.status !== 'active' || state.activeId !== id) return state;
  const def = defOf(state, id);
  const nextIndex = r.checkpointIndex + 1;
  if (nextIndex >= def.checkpoints.length) {
    const runtime = { ...state.runtime, [id]: { ...r, status: 'complete' as const, checkpointIndex: nextIndex } };
    const completedIds = state.completedIds.includes(id) ? state.completedIds : [...state.completedIds, id];
    return { ...state, runtime, activeId: null, money: state.money + def.reward, completedIds };
  }
  const runtime = { ...state.runtime, [id]: { ...r, checkpointIndex: nextIndex } };
  return { ...state, runtime };
}

/** Fail the active mission `id` outright (e.g. the player quit the pause menu mid-mission). No-op
 *  unless `id` is currently active. `'failed'` is not a dead end: `reviveFailedMissions` returns it
 *  to `'available'` after `FAILED_RETRY_COOLDOWN`, so it can be attempted again. */
export function failMission(state: MissionsState, id: string): MissionsState {
  const r = state.runtime[id];
  if (!r || r.status !== 'active') return state;
  const runtime = { ...state.runtime, [id]: { ...r, status: 'failed' as const, retryCooldown: FAILED_RETRY_COOLDOWN } };
  return { ...state, runtime, activeId: state.activeId === id ? null : state.activeId };
}

/**
 * Tick every `'failed'` mission's retry cooldown down by `dt`, returning it to a fresh `'available'`
 * state once the cooldown elapses so its start marker reappears in the world and it can be started
 * again. `'failed'` is meant to be a brief, transient status (just long enough for the HUD toast to
 * read) rather than the end of that mission's content — see `FAILED_RETRY_COOLDOWN`. Cheap: a no-op
 * (returns `state` unchanged) whenever nothing is currently `'failed'`, and only allocates the
 * runtime record once something actually needs reviving. Call unconditionally every tick, like
 * `stepActiveMission`.
 */
export function reviveFailedMissions(state: MissionsState, dt: number): MissionsState {
  let runtime: Record<string, MissionRuntime> | undefined;
  for (const def of state.defs) {
    const r = state.runtime[def.id];
    if (!r || r.status !== 'failed') continue;
    if (!runtime) runtime = { ...state.runtime };
    const remaining = r.retryCooldown - dt;
    runtime[def.id] = remaining <= 0 ? freshRuntime(def) : { ...r, retryCooldown: remaining };
  }
  return runtime ? { ...state, runtime } : state;
}

export interface MissionTickContext {
  /** Is the player currently driving (any vehicle)? */
  inVehicle: boolean;
  /** Has the vehicle the player is (or was) driving hit `damage >= 1`? */
  wrecked: boolean;
}

/**
 * Advance the active mission's clock by `dt`, failing it on timeout, on `wrecked`, or — for a race
 * only, per the spec ("leaving the vehicle for > 10 s during a race") — after `ctx.inVehicle` has
 * been false for more than `OUT_OF_VEHICLE_FAIL_TIME` consecutive seconds. A no-op when no mission
 * is active (cheap to call unconditionally every tick, like `stepWanted`).
 */
export function stepActiveMission(state: MissionsState, dt: number, ctx: MissionTickContext): MissionsState {
  const id = state.activeId;
  if (!id) return state;
  const r = state.runtime[id];
  if (!r || r.status !== 'active') return state;
  if (ctx.wrecked) return failMission(state, id);
  const timeRemaining = Math.max(0, r.timeRemaining - dt);
  if (timeRemaining <= 0) {
    const runtime = { ...state.runtime, [id]: { ...r, timeRemaining: 0 } };
    return failMission({ ...state, runtime }, id);
  }
  const def = defOf(state, id);
  const outOfVehicleTime = def.type === 'race' && !ctx.inVehicle ? r.outOfVehicleTime + dt : 0;
  if (outOfVehicleTime > OUT_OF_VEHICLE_FAIL_TIME) {
    const runtime = { ...state.runtime, [id]: { ...r, timeRemaining, outOfVehicleTime } };
    return failMission({ ...state, runtime }, id);
  }
  const runtime = { ...state.runtime, [id]: { ...r, timeRemaining, outOfVehicleTime } };
  return { ...state, runtime };
}

/** Number of mission definitions currently `'available'` to start. */
export function availableCount(state: MissionsState): number {
  let n = 0;
  for (const def of state.defs) if (state.runtime[def.id]?.status === 'available') n++;
  return n;
}

// -----------------------------------------------------------------------------------------------
// HUD helpers (pure — see `Game.missionHudLabel`).
// -----------------------------------------------------------------------------------------------

/**
 * Bearing (radians, in `[-PI, PI]`) of the world point `(tx, tz)` relative to the forward direction
 * of something at `(x, z)` facing `heading`: `0` is dead ahead, positive is to the player's right,
 * `+-PI` is directly behind. Uses the project's own convention (`forward = (sin h, cos h)`,
 * `right = (-cos h, sin h)`, see docs/ARCHITECTURE.md) rather than a raw `atan2` of the world
 * delta, so the HUD arrow points the same way the steering does.
 */
export function relativeBearing(x: number, z: number, heading: number, tx: number, tz: number): number {
  const dx = tx - x;
  const dz = tz - z;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const forward = dx * sin + dz * cos;
  const right = dx * -cos + dz * sin;
  return Math.atan2(right, forward);
}

/** The eight compass arrows, clockwise from "dead ahead" — index `i` covers bearings around
 *  `i * 45` degrees to the player's right (see `relativeBearing`). */
const BEARING_ARROWS = ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'] as const;

/** The arrow glyph pointing at a target `bearing` radians off the player's forward direction —
 *  the "arrow pointing toward the next checkpoint" the HUD line leads with. */
export function bearingArrow(bearing: number): string {
  if (!Number.isFinite(bearing)) return BEARING_ARROWS[0];
  const step = (Math.PI * 2) / BEARING_ARROWS.length;
  const i = ((Math.round(bearing / step) % BEARING_ARROWS.length) + BEARING_ARROWS.length) % BEARING_ARROWS.length;
  return BEARING_ARROWS[i]!;
}

/** `seconds` as `m:ss` for the HUD's mission timer (clamped at 0 — a mission fails the moment its
 *  clock reaches zero, so a negative readout should never be shown). */
export function formatMissionTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// -----------------------------------------------------------------------------------------------
// Save/load (localStorage, versioned key — mirrors `Quality.ts`'s `saveQuality`/`loadSavedQuality`).
// -----------------------------------------------------------------------------------------------

const MISSIONS_STORAGE_KEY = 'gta7.missions.v1';

export interface MissionsSaveData {
  money: number;
  completedIds: string[];
}

const EMPTY_SAVE: MissionsSaveData = { money: 0, completedIds: [] };

export function loadMissionsSave(storage: Pick<Storage, 'getItem'> | null): MissionsSaveData {
  if (!storage) return { ...EMPTY_SAVE };
  try {
    const raw = storage.getItem(MISSIONS_STORAGE_KEY);
    if (!raw) return { ...EMPTY_SAVE };
    const parsed = JSON.parse(raw) as Partial<MissionsSaveData>;
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_SAVE };
    const money = typeof parsed.money === 'number' && Number.isFinite(parsed.money) ? Math.max(0, parsed.money) : 0;
    const completedIds = Array.isArray(parsed.completedIds) ? parsed.completedIds.filter((x): x is string => typeof x === 'string') : [];
    return { money, completedIds };
  } catch {
    return { ...EMPTY_SAVE };
  }
}

export function saveMissionsSave(storage: Pick<Storage, 'setItem'> | null, data: MissionsSaveData): void {
  if (!storage) return;
  try {
    storage.setItem(MISSIONS_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota / private mode: ignore, like `saveQuality` */
  }
}

/** Clear the save (the settings menu's "Reset missions" button). */
export function resetMissionsSave(storage: Pick<Storage, 'removeItem'> | null): void {
  if (!storage) return;
  try {
    storage.removeItem(MISSIONS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
