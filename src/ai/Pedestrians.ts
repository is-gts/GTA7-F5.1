/**
 * Pedestrian AI: NPCs that walk the sidewalks, cross at intersections, react to danger (step back /
 * run from fast vehicles) and get knocked down when actually hit by one.
 *
 * Pure logic (the sidewalk graph + agent state machine) lives first so it can be unit-tested
 * without three.js, mirroring `src/ai/Traffic.ts`. `PedestrianSystem` at the bottom is the thin
 * three.js-facing layer: a pooled, quality-gated population of cheap meshes driven by the pure
 * agents each fixed step.
 *
 * --- The sidewalk graph -------------------------------------------------------------------------
 * Every block has a "ring" of 4 nodes: its corners, inset `sidewalkWidth/2` from the block edge —
 * i.e. the centreline of the sidewalk band that `CityBuilder` renders around every block (see the
 * `north`/`south`/`west`/`east` sidewalk strips there, each `sidewalkWidth` wide). The four ring
 * edges connect consecutive corners, so walking the ring keeps an agent on that centreline the
 * whole way round, whatever the block's kind (buildings, park or plaza all get the same ring).
 *
 * At every road graph edge that borders two blocks, a "crossing" edge connects the two blocks'
 * nearest corners at each end of that edge (i.e. right at the intersections, not mid-block) — a
 * pedestrian crosswalk over that stretch of road. A 4-way interior intersection therefore has up
 * to 4 crossings, one per side, connecting each pair of adjacent quadrant blocks — exactly the loop
 * of crosswalks a real 4-way junction has. A T-junction or the city's outer edge simply has fewer.
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, CapsuleGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QualitySettings } from '../core/Quality';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import { circleVsOBB, StaticColliderGrid, type OBB } from '../physics/Collision';
import {
  DEFAULT_CHARACTER_SPEC,
  createCharacterState,
  resolveCharacterOBB,
  resolveCharacterStatic,
  stepCharacter,
  type CharacterSpec,
  type CharacterState,
} from '../physics/CharacterController';
import { wrapAngle } from '../physics/VehiclePhysics';
import { HUMAN_FIGURE } from '../entities/HumanFigure';
import { Random } from '../world/Random';
import type { CityData } from '../world/CityGenerator';
import type { TrafficObstacle } from './Traffic';

// -----------------------------------------------------------------------------------------------
// Sidewalk graph
// -----------------------------------------------------------------------------------------------

export interface SidewalkNode {
  id: number;
  x: number;
  z: number;
  /** Index into `city.blocks` of the block this corner belongs to. */
  blockIndex: number;
}

export type SidewalkEdgeKind = 'ring' | 'crossing';

export interface SidewalkEdge {
  id: number;
  a: number;
  b: number;
  kind: SidewalkEdgeKind;
}

export interface SidewalkGraph {
  nodes: SidewalkNode[];
  edges: SidewalkEdge[];
  /** node id -> neighbouring node ids (undirected). */
  adjacency: number[][];
}

const SW = 0;
const SE = 1;
const NE = 2;
const NW = 3;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Build the pure sidewalk + crosswalk graph from the city's blocks and road graph. */
export function buildSidewalkGraph(city: CityData): SidewalkGraph {
  const p = city.params;
  const cols = p.cols;
  const rows = p.rows;
  const nodes: SidewalkNode[] = [];
  const edges: SidewalkEdge[] = [];
  const adjacency: number[][] = [];
  /** blockIndex -> [swId, seId, neId, nwId]. */
  const corners: number[][] = new Array(cols * rows);

  const addNode = (x: number, z: number, blockIndex: number): number => {
    const id = nodes.length;
    nodes.push({ id, x, z, blockIndex });
    adjacency.push([]);
    return id;
  };
  const addEdge = (a: number, b: number, kind: SidewalkEdgeKind): void => {
    const id = edges.length;
    edges.push({ id, a, b, kind });
    adjacency[a]!.push(b);
    adjacency[b]!.push(a);
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const blockIndex = j * cols + i;
      const block = city.blocks[blockIndex]!;
      const half = p.sidewalkWidth / 2;
      const x0 = block.x0 + half;
      const x1 = block.x0 + block.size - half;
      const z0 = block.z0 + half;
      const z1 = block.z0 + block.size - half;
      const sw = addNode(x0, z0, blockIndex);
      const se = addNode(x1, z0, blockIndex);
      const ne = addNode(x1, z1, blockIndex);
      const nw = addNode(x0, z1, blockIndex);
      addEdge(sw, se, 'ring');
      addEdge(se, ne, 'ring');
      addEdge(ne, nw, 'ring');
      addEdge(nw, sw, 'ring');
      corners[blockIndex] = [sw, se, ne, nw];
    }
  }

  const blockAt = (i: number, j: number): number | null => (i >= 0 && i < cols && j >= 0 && j < rows ? j * cols + i : null);

  // Crosswalks: one per (road edge, end) pair that has a block on both sides of the road there.
  for (const e of city.roads.edges) {
    const na = city.roads.nodes[e.a]!;
    const nb = city.roads.nodes[e.b]!;
    if (e.axis === 'x') {
      // Horizontal road at row j = na.j, spanning column i = na.i (na.i < nb.i by construction).
      const j = na.j;
      const i = na.i;
      const south = blockAt(i, j - 1);
      const north = blockAt(i, j);
      if (south !== null && north !== null) {
        addEdge(corners[south]![NW]!, corners[north]![SW]!, 'crossing'); // west end (node a)
        addEdge(corners[south]![NE]!, corners[north]![SE]!, 'crossing'); // east end (node b)
      }
    } else {
      // Vertical road at column i = na.i, spanning row j = na.j (na.j < nb.j by construction).
      const i = na.i;
      const j = na.j;
      const west = blockAt(i - 1, j);
      const east = blockAt(i, j);
      if (west !== null && east !== null) {
        addEdge(corners[west]![SE]!, corners[east]![SW]!, 'crossing'); // south end (node a)
        addEdge(corners[west]![NE]!, corners[east]![NW]!, 'crossing'); // north end (node b)
      }
    }
  }

  return { nodes, edges, adjacency };
}

/** Minimum distance (m) from (x,z) to any sidewalk/crossing edge segment. */
export function distanceToSidewalkGraph(graph: SidewalkGraph, x: number, z: number): number {
  let best = Infinity;
  for (const e of graph.edges) {
    const a = graph.nodes[e.a]!;
    const b = graph.nodes[e.b]!;
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

/**
 * Pick the next node to walk to from `arrivedAt`, excluding `cameFrom` unless that is the only
 * neighbour (every ring node has at least 2, so this only matters at true dead ends, which don't
 * occur here — kept for symmetry with `Traffic.chooseNextPath` and future-proofing). Deterministic
 * given `rng`.
 */
export function pickNextSidewalkNode(graph: SidewalkGraph, rng: Random, arrivedAt: number, cameFrom: number): number {
  const neighbours = graph.adjacency[arrivedAt] ?? [];
  const candidates = neighbours.filter((n) => n !== cameFrom);
  const pool = candidates.length > 0 ? candidates : neighbours;
  return pool[rng.int(0, pool.length - 1)]!;
}

// -----------------------------------------------------------------------------------------------
// Pure agent logic
// -----------------------------------------------------------------------------------------------

export type PedestrianMode = 'walk' | 'wait' | 'flee' | 'down' | 'getup';

export interface PedestrianAgent {
  id: number;
  state: CharacterState;
  /** State at the previous fixed step, for render interpolation (mirrors TrafficAgent). */
  prev: CharacterState;
  spec: CharacterSpec;
  mode: PedestrianMode;
  /** The node the agent is walking away from. */
  fromNode: number;
  /** The node the agent is walking toward. */
  toNode: number;
  /** Countdown (s) for the current `wait` / `flee` / `down` / `getup` state; unused in `walk`. */
  timer: number;
  rng: Random;
}

/** Radius (m) within which an agent is considered to have reached its target node. */
const ARRIVAL_RADIUS = 0.35;
/** Chance an agent pauses (`wait`) for a moment after reaching a node, instead of walking straight on. */
const WAIT_CHANCE = 0.15;
const WAIT_MIN = 0.4;
const WAIT_MAX = 1.6;
/** A vehicle closing on the agent faster than this (m/s), within `FLEE_RADIUS`, triggers a flee. */
const FLEE_TRIGGER_SPEED = 4;
const FLEE_RADIUS = 8;
const FLEE_MIN = 2;
const FLEE_MAX = 3;
/** A vehicle overlapping the agent faster than this (m/s) knocks it down. */
const HIT_MIN_SPEED = 2;
const DOWN_MIN = 4;
const DOWN_MAX = 8;
const GETUP_DURATION = 1.2;
/** Knockback speed (m/s) imparted when knocked down, capped so a very fast car doesn't launch it. */
const KNOCKBACK_CAP = 6;

export function createPedestrianSpec(rng: Random): CharacterSpec {
  return {
    ...DEFAULT_CHARACTER_SPEC,
    radius: 0.3,
    walkSpeed: rng.range(1.0, 1.6),
    runSpeed: rng.range(3, 4.2),
    acceleration: 6,
    deceleration: 10,
    turnRate: 8,
  };
}

/** Build a fresh agent standing on `startNode`, already aimed at a first target. */
export function createPedestrianAgent(id: number, graph: SidewalkGraph, startNode: number, rng: Random, spec: CharacterSpec): PedestrianAgent {
  const n = graph.nodes[startNode]!;
  const toNode = pickNextSidewalkNode(graph, rng, startNode, startNode);
  const target = graph.nodes[toNode]!;
  const heading = Math.atan2(target.x - n.x, target.z - n.z);
  const state = createCharacterState(n.x, n.z, heading);
  return { id, state, prev: { ...state }, spec, mode: 'walk', fromNode: startNode, toNode, timer: 0, rng };
}

function obstacleOBB(ob: TrafficObstacle): OBB {
  return { x: ob.x, z: ob.z, halfW: ob.halfWidth, halfL: ob.halfLength, heading: ob.heading };
}

const EMPTY_OBSTACLES: readonly TrafficObstacle[] = [];

/**
 * Advance one agent by `dt`: react to nearby vehicles (get knocked down, or flee an approaching
 * one), otherwise walk the sidewalk graph toward its current target, picking a new one on arrival.
 */
export function advancePedestrian(
  agent: PedestrianAgent,
  graph: SidewalkGraph,
  dt: number,
  obstacles: readonly TrafficObstacle[] = EMPTY_OBSTACLES,
  grid?: StaticColliderGrid,
  onHit?: (speed: number) => void,
): void {
  Object.assign(agent.prev, agent.state);
  const s = agent.state;

  if (agent.mode === 'down') {
    agent.timer -= dt;
    stepCharacter(s, agent.spec, { dirX: 0, dirZ: 0, run: false }, dt);
    if (grid) resolveCharacterStatic(s, agent.spec, grid);
    if (agent.timer <= 0) {
      agent.mode = 'getup';
      agent.timer = GETUP_DURATION;
    }
    return;
  }
  if (agent.mode === 'getup') {
    agent.timer -= dt;
    if (agent.timer <= 0) agent.mode = 'walk';
    return;
  }

  // --- get knocked down: any vehicle whose OBB overlaps the agent while moving fast enough -------
  for (let i = 0; i < obstacles.length; i++) {
    const ob = obstacles[i]!;
    if (Math.abs(ob.forwardSpeed) < HIT_MIN_SPEED) continue;
    if (!circleVsOBB({ x: s.x, z: s.z, r: agent.spec.radius }, obstacleOBB(ob))) continue;
    agent.mode = 'down';
    agent.timer = agent.rng.range(DOWN_MIN, DOWN_MAX);
    const dx = s.x - ob.x;
    const dz = s.z - ob.z;
    const d = Math.hypot(dx, dz) || 1;
    const kb = Math.min(Math.abs(ob.forwardSpeed) * 0.5, KNOCKBACK_CAP);
    s.vx = (dx / d) * kb;
    s.vz = (dz / d) * kb;
    s.moveBlend = 0;
    onHit?.(Math.abs(ob.forwardSpeed));
    return;
  }

  // --- flee: a vehicle closing fast from nearby, not already fleeing --------------------------
  if (agent.mode !== 'flee') {
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i]!;
      const dx = s.x - ob.x;
      const dz = s.z - ob.z;
      const dist = Math.hypot(dx, dz);
      if (dist > FLEE_RADIUS || dist < 1e-6) continue;
      const vx = Math.sin(ob.heading) * ob.forwardSpeed;
      const vz = Math.cos(ob.heading) * ob.forwardSpeed;
      // Rate of closure (positive = approaching): r = agent - vehicle, dist' = -(r . v) / |r|, so
      // the closing speed (how fast |r| shrinks) is +(r . v) / |r|.
      const closing = (vx * dx + vz * dz) / dist;
      if (closing <= FLEE_TRIGGER_SPEED) continue;
      agent.mode = 'flee';
      agent.timer = agent.rng.range(FLEE_MIN, FLEE_MAX);
      // Aim for whichever end of the current edge is farther from the threat.
      const from = graph.nodes[agent.fromNode]!;
      const to = graph.nodes[agent.toNode]!;
      const dFrom = Math.hypot(from.x - ob.x, from.z - ob.z);
      const dTo = Math.hypot(to.x - ob.x, to.z - ob.z);
      if (dFrom > dTo) {
        const tmp = agent.fromNode;
        agent.fromNode = agent.toNode;
        agent.toNode = tmp;
      }
      break;
    }
  }

  if (agent.mode === 'wait') {
    agent.timer -= dt;
    stepCharacter(s, agent.spec, { dirX: 0, dirZ: 0, run: false }, dt);
    if (grid) resolveCharacterStatic(s, agent.spec, grid);
    for (let i = 0; i < obstacles.length; i++) resolveCharacterOBB(s, agent.spec, obstacleOBB(obstacles[i]!));
    if (agent.timer <= 0) agent.mode = 'walk';
    return;
  }

  if (agent.mode === 'flee') {
    agent.timer -= dt;
    if (agent.timer <= 0) agent.mode = 'walk';
  }

  const target = graph.nodes[agent.toNode]!;
  const dx = target.x - s.x;
  const dz = target.z - s.z;
  const dist = Math.hypot(dx, dz);
  stepCharacter(s, agent.spec, { dirX: dx, dirZ: dz, run: agent.mode === 'flee' }, dt);
  if (grid) resolveCharacterStatic(s, agent.spec, grid);
  for (let i = 0; i < obstacles.length; i++) resolveCharacterOBB(s, agent.spec, obstacleOBB(obstacles[i]!));

  if (dist < ARRIVAL_RADIUS) {
    const arrivedAt = agent.toNode;
    const cameFrom = agent.fromNode;
    agent.fromNode = arrivedAt;
    if (agent.mode === 'walk' && agent.rng.chance(WAIT_CHANCE)) {
      agent.mode = 'wait';
      agent.timer = agent.rng.range(WAIT_MIN, WAIT_MAX);
    }
    agent.toNode = pickNextSidewalkNode(graph, agent.rng, arrivedAt, cameFrom);
  }
}

export interface PedestrianPopulationOptions {
  grid?: StaticColliderGrid;
  /** Vehicles (traffic + parked/player cars) to react to. */
  vehicles?: readonly TrafficObstacle[];
  onHit?: (speed: number) => void;
}

/** Advance a whole population for one fixed step. No pedestrian-pedestrian collision: cheap, and the
 *  sidewalk network is wide relative to the pedestrian radius, so crowding is rare enough not to be
 *  worth the O(n^2) cost at the population sizes this game uses. */
export function stepPedestrianPopulation(agents: readonly PedestrianAgent[], graph: SidewalkGraph, dt: number, opts: PedestrianPopulationOptions = {}): void {
  const vehicles = opts.vehicles ?? EMPTY_OBSTACLES;
  for (let i = 0; i < agents.length; i++) advancePedestrian(agents[i]!, graph, dt, vehicles, opts.grid, opts.onHit);
}

// -----------------------------------------------------------------------------------------------
// Rendering: a thin, pooled three.js layer
// -----------------------------------------------------------------------------------------------

/**
 * Merged, static (unanimated) three-material figure for the pedestrian pool: bucket 0 = skin
 * (head), bucket 1 = shirt (chest + arms), bucket 2 = pants (legs). Built once from the same
 * dimensions as the player's animated rig (`HUMAN_FIGURE`) so the two match visually; pooled
 * pedestrians don't get the player's per-limb walk animation (a cheap, deliberate simplification —
 * there can be dozens of them, one draw call each already).
 */
function buildPedestrianGeometry(): BufferGeometry {
  const f = HUMAN_FIGURE;
  const mergeBucket = (parts: BufferGeometry[]): BufferGeometry => {
    const merged = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    return merged;
  };
  const skin = mergeBucket([new SphereGeometry(f.headRadius, 10, 8).translate(0, f.headY, 0)]);
  const shirtParts: BufferGeometry[] = [new CapsuleGeometry(f.chestRadius, f.chestLength, 4, 8).translate(0, f.chestY, 0)];
  for (const side of [-1, 1]) shirtParts.push(new BoxGeometry(...f.armSize).translate(side * f.armOffsetX, f.armPivotY + f.armLocalY, 0));
  const shirt = mergeBucket(shirtParts);
  const pantsParts: BufferGeometry[] = [];
  for (const side of [-1, 1]) pantsParts.push(new BoxGeometry(...f.legSize).translate(side * f.legOffsetX, f.legPivotY + f.legLocalY, 0));
  const pants = mergeBucket(pantsParts);
  const buckets = [skin, shirt, pants];
  const merged = mergeGeometries(buckets, true)!;
  for (const b of buckets) b.dispose();
  merged.computeBoundingSphere();
  return merged;
}

const SHIRT_PALETTE = [0xb23b3b, 0x2f6fae, 0xd8b23a, 0x2c2c34, 0xdedede, 0x3f8f4f, 0x7a4fae, 0xc97a2c, 0x556070, 0x8a4fd6, 0xe0895a, 0x4fae8a];

interface PedSlot {
  /** World position + heading. */
  group: Group;
  /** Child of `group`; tilted separately to lie flat while `down`/`getup`. */
  figure: Group;
  shirt: MeshStandardMaterial;
  agent: PedestrianAgent | null;
}

export interface PedestrianFocus {
  x: number;
  z: number;
}

/** Keep spawns at least this far (m) from a focus and no farther than the effective spawn radius. */
const MIN_SPAWN_DIST = 10;
/** Pedestrians are small and slow; there's no benefit to spawning them as far out as traffic. */
const MAX_SPAWN_RADIUS = 150;
const HALF_PI = Math.PI / 2;

/** Owns a fixed-size pool of pooled pedestrian meshes and the AI agents driving them. */
export class PedestrianSystem {
  readonly object = new Group();
  private slots: PedSlot[] = [];
  private agents: PedestrianAgent[] = [];
  /** Persistent buffer behind `positions` (no per-call allocation for the minimap). */
  private readonly positionView: { x: number; z: number }[] = [];
  private geometry: BufferGeometry | null = null;
  private skinMat: MeshStandardMaterial | null = null;
  private pantsMat: MeshStandardMaterial | null = null;
  private readonly graph: SidewalkGraph;
  private readonly rng: Random;
  private nextId = 1;
  private spawnRadius: number;
  private readonly despawnMargin = 40;
  private readonly minSeparation = 4;
  /** Reused, index-aligned `TrafficObstacle` view of what `update()` was passed (no per-tick alloc). */
  private vehicleCache: TrafficObstacle[] = [];

  constructor(
    city: CityData,
    private readonly registry: MaterialRegistry,
    quality: QualitySettings,
    seed: number,
    focus: PedestrianFocus,
  ) {
    this.object.name = 'pedestrians';
    this.graph = buildSidewalkGraph(city);
    this.rng = new Random(seed ^ 0x2f4a9d17);
    this.spawnRadius = Math.min(quality.drawDistance, MAX_SPAWN_RADIUS);
    this.rebuild(quality, focus);
  }

  /** Resize the pool for a new quality preset and refill it near `focus` (called on quality change). */
  rebuild(quality: QualitySettings, focus: PedestrianFocus): void {
    this.disposePool();
    this.spawnRadius = Math.min(quality.drawDistance, MAX_SPAWN_RADIUS);
    this.geometry = buildPedestrianGeometry();
    this.skinMat = this.registry.register(new MeshStandardMaterial({ color: 0xd9a57a, roughness: 0.8 }));
    this.pantsMat = this.registry.register(new MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.9 }));
    const castShadow = quality.shadows === 'csm';
    const count = Math.max(0, quality.maxPedestrians);
    for (let i = 0; i < count; i++) this.slots.push(this.createSlot(castShadow));
    // Unlike a single failed attempt, a full pool fill is not urgent (it only runs at construction
    // and on quality change), so keep drawing fresh random candidates for the whole guard budget
    // rather than giving up after the first miss — with only ~4 grid corners per block and a small
    // `minSeparation`, an unlucky run of 24 draws with no valid candidate is common enough (and
    // cheap enough to just retry) that stopping there would under-fill the pool.
    let guard = count * 12;
    while (guard-- > 0 && this.slots.some((sl) => !sl.agent)) this.trySpawn(focus);
  }

  private createSlot(castShadow: boolean): PedSlot {
    const shirt = this.registry.register(new MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.85 }));
    const mesh = new Mesh(this.geometry!, [this.skinMat!, shirt, this.pantsMat!]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    const figure = new Group();
    figure.add(mesh);
    const group = new Group();
    group.add(figure);
    group.visible = false;
    this.object.add(group);
    return { group, figure, shirt, agent: null };
  }

  private trySpawn(focus: PedestrianFocus): boolean {
    const free = this.slots.find((s) => !s.agent);
    if (!free) return false;
    const nodes = this.graph.nodes;
    if (nodes.length === 0) return false;
    let chosen = -1;
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = this.rng.int(0, nodes.length - 1);
      const n = nodes[candidate]!;
      const d = Math.hypot(n.x - focus.x, n.z - focus.z);
      if (d < MIN_SPAWN_DIST || d > this.spawnRadius) continue;
      let clear = true;
      for (const s of this.slots) {
        if (!s.agent) continue;
        if (Math.hypot(s.agent.state.x - n.x, s.agent.state.z - n.z) < this.minSeparation) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      chosen = candidate;
      break;
    }
    if (chosen < 0) return false;
    const id = this.nextId++;
    const agentRng = this.rng.fork(`ped-agent:${id}`);
    const spec = createPedestrianSpec(agentRng);
    const agent = createPedestrianAgent(id, this.graph, chosen, agentRng, spec);
    free.agent = agent;
    free.shirt.color.set(this.rng.pick(SHIRT_PALETTE));
    free.group.visible = true;
    free.group.position.set(agent.state.x, 0, agent.state.z);
    free.group.rotation.set(0, agent.state.heading, 0);
    free.figure.rotation.set(0, 0, 0);
    this.agents.push(agent);
    return true;
  }

  private despawn(slot: PedSlot): void {
    const agent = slot.agent;
    if (agent) {
      const idx = this.agents.indexOf(agent);
      if (idx >= 0) {
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
   * `vehicles` covers every vehicle (parked, player-driven, and traffic AI) so pedestrians can react
   * to all of them; pass a persistent, reused array — entries are copied into an internal cache, so
   * no reference is retained past this call.
   */
  update(dt: number, focus: PedestrianFocus, grid: StaticColliderGrid, vehicles: readonly TrafficObstacle[], onHit?: (speed: number) => void): void {
    const despawnAt = this.spawnRadius + this.despawnMargin;
    for (const slot of this.slots) {
      const agent = slot.agent;
      if (!agent) continue;
      const d = Math.hypot(agent.state.x - focus.x, agent.state.z - focus.z);
      if (d > despawnAt) this.despawn(slot);
    }
    for (let i = 0; i < 3; i++) {
      if (!this.trySpawn(focus)) break;
    }
    if (this.vehicleCache.length !== vehicles.length) this.vehicleCache = vehicles.map((v) => ({ ...v }));
    else for (let i = 0; i < vehicles.length; i++) Object.assign(this.vehicleCache[i]!, vehicles[i]!);
    stepPedestrianPopulation(this.agents, this.graph, dt, { grid, vehicles: this.vehicleCache, onHit });
  }

  /**
   * Startle every pedestrian within `radius` of `(x, z)` into fleeing (e.g. the player leaning on
   * the horn), regardless of whether a vehicle is actually closing on them. Agents already down,
   * getting up or fleeing are left alone.
   */
  startle(x: number, z: number, radius: number): void {
    const r2 = radius * radius;
    for (const agent of this.agents) {
      if (agent.mode !== 'walk' && agent.mode !== 'wait') continue;
      const dx = agent.state.x - x;
      const dz = agent.state.z - z;
      if (dx * dx + dz * dz > r2) continue;
      agent.mode = 'flee';
      agent.timer = agent.rng.range(FLEE_MIN, FLEE_MAX);
      // Aim for whichever end of the current edge is farther from the source, same as the
      // proximity-triggered flee above.
      const from = this.graph.nodes[agent.fromNode]!;
      const to = this.graph.nodes[agent.toNode]!;
      const dFrom = Math.hypot(from.x - x, from.z - z);
      const dTo = Math.hypot(to.x - x, to.z - z);
      if (dFrom > dTo) {
        const tmp = agent.fromNode;
        agent.fromNode = agent.toNode;
        agent.toNode = tmp;
      }
    }
  }

  /** Interpolate every active pooled pedestrian between its previous and current state. */
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
      const down = agent.mode === 'down' || agent.mode === 'getup';
      const tilt = down ? -HALF_PI : 0;
      slot.figure.rotation.x = tilt;
      slot.figure.position.y = down ? 0.35 : 0;
    }
  }

  /** World position of every active pedestrian (e.g. for the minimap's dynamic dot layer),
   *  refreshed in place in a persistent buffer rather than allocating one per call. */
  get positions(): readonly { x: number; z: number }[] {
    while (this.positionView.length < this.agents.length) this.positionView.push({ x: 0, z: 0 });
    this.positionView.length = this.agents.length;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i]!;
      const p = this.positionView[i]!;
      p.x = a.state.x;
      p.z = a.state.z;
    }
    return this.positionView;
  }

  /** Snapshot for debugging / e2e assertions. */
  get stats(): { agents: number; walking: number; down: number } {
    let walking = 0;
    let down = 0;
    for (const slot of this.slots) {
      const agent = slot.agent;
      if (!agent) continue;
      if (agent.mode === 'walk' || agent.mode === 'flee') walking++;
      if (agent.mode === 'down') down++;
    }
    return { agents: this.agents.length, walking, down };
  }

  private disposePool(): void {
    for (const slot of this.slots) {
      this.registry.unregister(slot.shirt);
      slot.shirt.dispose();
      slot.group.clear();
      slot.group.removeFromParent();
    }
    this.slots = [];
    this.agents = [];
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.skinMat) {
      this.registry.unregister(this.skinMat);
      this.skinMat.dispose();
      this.skinMat = null;
    }
    if (this.pantsMat) {
      this.registry.unregister(this.pantsMat);
      this.pantsMat.dispose();
      this.pantsMat = null;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.disposePool();
  }
}
