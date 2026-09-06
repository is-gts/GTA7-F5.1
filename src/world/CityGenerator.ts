/**
 * Deterministic procedural city generator. Produces plain data (no three.js) so it can be
 * unit-tested and consumed by both rendering (CityBuilder) and simulation (traffic, physics).
 *
 * Coordinate system: XZ ground plane, Y up, metres. Heading θ is rotation about +Y where
 * forward = (sin θ, cos θ) and right = forward × up = (−cos θ, sin θ). This matches three.js
 * `Object3D.rotation.y` for a model whose front faces local +Z. Increasing θ turns LEFT.
 */
import { Random, valueNoise2D } from './Random';

export interface CityParams {
  seed: number;
  /** Number of blocks along X. */
  cols: number;
  /** Number of blocks along Z. */
  rows: number;
  /** Block edge length (metres) including sidewalks. */
  blockSize: number;
  /** Road width (metres) between blocks. */
  roadWidth: number;
  sidewalkWidth: number;
  laneWidth: number;
  /** Blocks per chunk edge (for culling / LOD grouping). */
  chunkBlocks: number;
}

export const DEFAULT_CITY_PARAMS: CityParams = {
  seed: 7,
  cols: 14,
  rows: 14,
  blockSize: 64,
  roadWidth: 14,
  sidewalkWidth: 3.5,
  laneWidth: 3.5,
  chunkBlocks: 2,
};

export type BlockKind = 'buildings' | 'park' | 'plaza';
export type DistrictKind = 'downtown' | 'midtown' | 'suburb' | 'industrial';

export interface Building {
  id: number;
  /** Footprint centre. */
  x: number;
  z: number;
  /** Footprint size along X / Z. */
  w: number;
  d: number;
  h: number;
  /** Facade style index (material variant). */
  style: number;
  /** Colour tint 0..1 used to vary instances. */
  tint: number;
  /** Whether the roof has a raised "crown" (visual only). */
  crown: boolean;
  chunkKey: string;
}

export interface Block {
  i: number;
  j: number;
  /** Min corner. */
  x0: number;
  z0: number;
  size: number;
  kind: BlockKind;
  district: DistrictKind;
  buildings: Building[];
  chunkKey: string;
}

export interface RoadNode {
  id: number;
  i: number;
  j: number;
  x: number;
  z: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** 'x' = runs along X (varying x, constant z), 'z' = runs along Z. */
  axis: 'x' | 'z';
  length: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** node id -> edge ids */
  adjacency: number[][];
}

export interface Lamp {
  x: number;
  z: number;
  /** Rotation so the arm points toward the road. */
  rotY: number;
  chunkKey: string;
}

export interface Tree {
  x: number;
  z: number;
  scale: number;
  chunkKey: string;
}

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Spawn {
  x: number;
  z: number;
  heading: number;
}

export interface CityData {
  params: CityParams;
  bounds: Bounds;
  blocks: Block[];
  buildings: Building[];
  roads: RoadGraph;
  lamps: Lamp[];
  trees: Tree[];
  spawn: Spawn;
  /** Distinct chunk keys with their centre / bounds (for culling). */
  chunks: ChunkInfo[];
}

export interface ChunkInfo {
  key: string;
  cx: number;
  cz: number;
  bounds: Bounds;
}

export const FACADE_STYLE_COUNT = 6;

/** Pitch between road centrelines. */
export function blockPitch(p: CityParams): number {
  return p.blockSize + p.roadWidth;
}

/** World-space position of the road centreline for grid index `k` (0..cols or 0..rows). */
export function gridLine(p: CityParams, k: number, axis: 'x' | 'z'): number {
  const count = axis === 'x' ? p.cols : p.rows;
  const total = count * blockPitch(p);
  return k * blockPitch(p) - total / 2;
}

export function chunkKeyFor(p: CityParams, i: number, j: number): string {
  const ci = Math.floor(i / p.chunkBlocks);
  const cj = Math.floor(j / p.chunkBlocks);
  return `${ci},${cj}`;
}

/** Lane centre offsets from the road centreline for one direction of travel (metres). */
export function laneOffsets(p: CityParams): number[] {
  const lanesPerDir = Math.max(1, Math.floor(p.roadWidth / 2 / p.laneWidth));
  const out: number[] = [];
  for (let l = 0; l < lanesPerDir; l++) out.push(p.laneWidth * (l + 0.5));
  return out;
}

export function generateCity(partial: Partial<CityParams> = {}): CityData {
  const p: CityParams = { ...DEFAULT_CITY_PARAMS, ...partial };
  if (p.cols < 1 || p.rows < 1) throw new Error('cols/rows must be >= 1');
  if (p.roadWidth < p.laneWidth * 2) throw new Error('roadWidth must fit at least one lane per direction');
  const rng = new Random(p.seed);
  const pitch = blockPitch(p);
  const half = p.roadWidth / 2;

  const bounds: Bounds = {
    minX: gridLine(p, 0, 'x') - half,
    maxX: gridLine(p, p.cols, 'x') + half,
    minZ: gridLine(p, 0, 'z') - half,
    maxZ: gridLine(p, p.rows, 'z') + half,
  };

  // --- road graph ---------------------------------------------------------
  const nodes: RoadNode[] = [];
  const nodeIndex = (i: number, j: number) => j * (p.cols + 1) + i;
  for (let j = 0; j <= p.rows; j++) {
    for (let i = 0; i <= p.cols; i++) {
      nodes.push({ id: nodeIndex(i, j), i, j, x: gridLine(p, i, 'x'), z: gridLine(p, j, 'z') });
    }
  }
  const edges: RoadEdge[] = [];
  const adjacency: number[][] = nodes.map(() => []);
  const addEdge = (a: number, b: number, axis: 'x' | 'z') => {
    const id = edges.length;
    edges.push({ id, a, b, axis, length: pitch });
    adjacency[a]!.push(id);
    adjacency[b]!.push(id);
  };
  for (let j = 0; j <= p.rows; j++) {
    for (let i = 0; i <= p.cols; i++) {
      if (i < p.cols) addEdge(nodeIndex(i, j), nodeIndex(i + 1, j), 'x');
      if (j < p.rows) addEdge(nodeIndex(i, j), nodeIndex(i, j + 1), 'z');
    }
  }

  // --- blocks & buildings -------------------------------------------------
  const blocks: Block[] = [];
  const buildings: Building[] = [];
  const lamps: Lamp[] = [];
  const trees: Tree[] = [];
  let buildingId = 0;
  const centreI = (p.cols - 1) / 2;
  const centreJ = (p.rows - 1) / 2;
  const maxR = Math.max(1, Math.hypot(centreI, centreJ));

  for (let j = 0; j < p.rows; j++) {
    for (let i = 0; i < p.cols; i++) {
      const brng = rng.fork(`block:${i}:${j}`);
      const x0 = gridLine(p, i, 'x') + half;
      const z0 = gridLine(p, j, 'z') + half;
      const chunkKey = chunkKeyFor(p, i, j);
      const r = Math.hypot(i - centreI, j - centreJ) / maxR; // 0 centre .. 1 edge
      const noise = valueNoise2D(i * 0.35 + 3.1, j * 0.35 + 7.7, p.seed);
      const district: DistrictKind =
        r < 0.32 ? 'downtown' : r < 0.62 ? (noise > 0.72 ? 'industrial' : 'midtown') : noise > 0.55 ? 'suburb' : 'industrial';

      let kind: BlockKind = 'buildings';
      const parkChance = district === 'downtown' ? 0.06 : district === 'suburb' ? 0.16 : 0.08;
      if (brng.chance(parkChance)) kind = 'park';
      else if (brng.chance(0.05)) kind = 'plaza';

      const block: Block = { i, j, x0, z0, size: p.blockSize, kind, district, buildings: [], chunkKey };

      if (kind === 'buildings') {
        const inner = p.blockSize - 2 * p.sidewalkWidth;
        const ix0 = x0 + p.sidewalkWidth;
        const iz0 = z0 + p.sidewalkWidth;
        // Lot subdivision: n x m lots with alleys.
        const lotsAcross = district === 'downtown' ? brng.int(1, 2) : district === 'suburb' ? brng.int(2, 3) : brng.int(1, 3);
        const lotsDown = district === 'downtown' ? brng.int(1, 2) : district === 'suburb' ? brng.int(2, 3) : brng.int(1, 3);
        const alley = 2;
        const lotW = (inner - alley * (lotsAcross - 1)) / lotsAcross;
        const lotD = (inner - alley * (lotsDown - 1)) / lotsDown;
        for (let lj = 0; lj < lotsDown; lj++) {
          for (let li = 0; li < lotsAcross; li++) {
            if (district === 'suburb' && brng.chance(0.15)) continue; // empty lot
            const lx0 = ix0 + li * (lotW + alley);
            const lz0 = iz0 + lj * (lotD + alley);
            const marginX = brng.range(0.5, Math.max(0.6, lotW * 0.18));
            const marginZ = brng.range(0.5, Math.max(0.6, lotD * 0.18));
            const w = Math.max(6, lotW - 2 * marginX);
            const d = Math.max(6, lotD - 2 * marginZ);
            let h: number;
            switch (district) {
              case 'downtown':
                h = brng.range(40, 130) * (1 - r * 0.5);
                break;
              case 'midtown':
                h = brng.range(14, 42);
                break;
              case 'industrial':
                h = brng.range(6, 14);
                break;
              default:
                h = brng.range(5, 11);
            }
            h = Math.round(h);
            const style = district === 'industrial' ? brng.int(4, 5) : district === 'suburb' ? brng.int(2, 3) : brng.int(0, 3);
            const b: Building = {
              id: buildingId++,
              x: lx0 + lotW / 2,
              z: lz0 + lotD / 2,
              w,
              d,
              h,
              style,
              tint: brng.next(),
              crown: district === 'downtown' && brng.chance(0.5),
              chunkKey,
            };
            block.buildings.push(b);
            buildings.push(b);
          }
        }
      } else if (kind === 'park') {
        const count = brng.int(10, 22);
        for (let t = 0; t < count; t++) {
          trees.push({
            x: brng.range(x0 + p.sidewalkWidth + 2, x0 + p.blockSize - p.sidewalkWidth - 2),
            z: brng.range(z0 + p.sidewalkWidth + 2, z0 + p.blockSize - p.sidewalkWidth - 2),
            scale: brng.range(0.8, 1.4),
            chunkKey,
          });
        }
      }

      // Street lamps along the block perimeter (on the sidewalk edge, facing the road).
      const spacing = 24;
      const inset = 0.8;
      for (let s = spacing / 2; s < p.blockSize; s += spacing) {
        lamps.push({ x: x0 + s, z: z0 + inset, rotY: Math.PI, chunkKey }); // north edge, arm toward -Z
        lamps.push({ x: x0 + s, z: z0 + p.blockSize - inset, rotY: 0, chunkKey }); // south edge, arm toward +Z
        lamps.push({ x: x0 + inset, z: z0 + s, rotY: -Math.PI / 2, chunkKey }); // west edge, arm toward -X
        lamps.push({ x: x0 + p.blockSize - inset, z: z0 + s, rotY: Math.PI / 2, chunkKey }); // east edge, arm toward +X
      }
      blocks.push(block);
    }
  }

  // --- chunks -------------------------------------------------------------
  const chunkMap = new Map<string, ChunkInfo>();
  for (const b of blocks) {
    let c = chunkMap.get(b.chunkKey);
    if (!c) {
      c = { key: b.chunkKey, cx: 0, cz: 0, bounds: { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity } };
      chunkMap.set(b.chunkKey, c);
    }
    c.bounds.minX = Math.min(c.bounds.minX, b.x0 - half);
    c.bounds.minZ = Math.min(c.bounds.minZ, b.z0 - half);
    c.bounds.maxX = Math.max(c.bounds.maxX, b.x0 + b.size + half);
    c.bounds.maxZ = Math.max(c.bounds.maxZ, b.z0 + b.size + half);
  }
  const chunks = Array.from(chunkMap.values());
  for (const c of chunks) {
    c.cx = (c.bounds.minX + c.bounds.maxX) / 2;
    c.cz = (c.bounds.minZ + c.bounds.maxZ) / 2;
  }

  // --- spawn: on the centre-most X-axis road, in the +X lane -----------------
  const spawnJ = Math.floor(p.rows / 2);
  const lane = laneOffsets(p)[0]!;
  const spawn: Spawn = {
    x: gridLine(p, Math.floor(p.cols / 2), 'x') + pitch / 2,
    // Right-hand traffic: driving toward +X uses the +Z side of the road (right of forward).
    z: gridLine(p, spawnJ, 'z') + lane,
    heading: Math.PI / 2, // forward = (sin, cos) = (+1, 0)
  };

  return {
    params: p,
    bounds,
    blocks,
    buildings,
    roads: { nodes, edges, adjacency },
    lamps,
    trees,
    spawn,
    chunks,
  };
}

/**
 * Position along an edge for a direction of travel. `t` in [0,1] runs from node `a` to `b` when
 * `forward` is true, otherwise from `b` to `a`. `laneIndex` picks the lane (0 = innermost).
 * Right-hand traffic: the lane offset is applied to the right of the direction of travel.
 */
export function lanePoint(
  city: CityData,
  edge: RoadEdge,
  t: number,
  forward: boolean,
  laneIndex = 0,
): { x: number; z: number; heading: number } {
  const na = city.roads.nodes[edge.a]!;
  const nb = city.roads.nodes[edge.b]!;
  const from = forward ? na : nb;
  const to = forward ? nb : na;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len;
  const fz = dz / len;
  const heading = Math.atan2(fx, fz);
  // right vector = forward x up = (-cos h, sin h) = (-fz, fx)
  const offsets = laneOffsets(city.params);
  const off = offsets[Math.min(laneIndex, offsets.length - 1)]!;
  return {
    x: from.x + dx * t - fz * off,
    z: from.z + dz * t + fx * off,
    heading,
  };
}

/** Axis-aligned collision boxes for every building (for the static physics grid). */
export function buildingAABBs(city: CityData): { id: number; minX: number; minZ: number; maxX: number; maxZ: number }[] {
  return city.buildings.map((b) => ({
    id: b.id,
    minX: b.x - b.w / 2,
    minZ: b.z - b.d / 2,
    maxX: b.x + b.w / 2,
    maxZ: b.z + b.d / 2,
  }));
}
