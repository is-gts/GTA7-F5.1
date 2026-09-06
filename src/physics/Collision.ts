/**
 * 2D (XZ plane) collision primitives. All heights are ignored: the city is flat and every
 * dynamic object is treated as a 2D shape for collision purposes, which keeps the physics
 * cheap enough for low-end devices.
 */
export interface AABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface OBB {
  x: number;
  z: number;
  /** Half extent along the local right axis. */
  halfW: number;
  /** Half extent along the local forward axis. */
  halfL: number;
  /** Rotation about Y. forward = (sin h, cos h), right = forward x up = (-cos h, sin h). */
  heading: number;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** Minimum translation vector: move the first shape by (nx*depth, nz*depth) to separate. */
export interface MTV {
  nx: number;
  nz: number;
  depth: number;
}

/** Contacts shallower than this are treated as touching, not overlapping (float noise guard). */
export const SAT_EPSILON = 1e-9;

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export function obbToAABB(o: OBB): AABB {
  const c = Math.abs(Math.cos(o.heading));
  const s = Math.abs(Math.sin(o.heading));
  const ex = o.halfW * c + o.halfL * s;
  const ez = o.halfW * s + o.halfL * c;
  return { minX: o.x - ex, maxX: o.x + ex, minZ: o.z - ez, maxZ: o.z + ez };
}

export function aabbToOBB(a: AABB): OBB {
  return {
    x: (a.minX + a.maxX) / 2,
    z: (a.minZ + a.maxZ) / 2,
    halfW: (a.maxX - a.minX) / 2,
    halfL: (a.maxZ - a.minZ) / 2,
    heading: 0,
  };
}

/** Circle vs AABB. Returns the MTV for the circle, or null when not overlapping. */
export function circleVsAABB(c: Circle, b: AABB): MTV | null {
  const cx = clamp(c.x, b.minX, b.maxX);
  const cz = clamp(c.z, b.minZ, b.maxZ);
  const dx = c.x - cx;
  const dz = c.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= c.r * c.r) return null;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, nz: dz / d, depth: c.r - d };
  }
  // Centre inside the box: push out along the nearest face.
  const toMinX = c.x - b.minX;
  const toMaxX = b.maxX - c.x;
  const toMinZ = c.z - b.minZ;
  const toMaxZ = b.maxZ - c.z;
  const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
  if (m === toMinX) return { nx: -1, nz: 0, depth: toMinX + c.r };
  if (m === toMaxX) return { nx: 1, nz: 0, depth: toMaxX + c.r };
  if (m === toMinZ) return { nx: 0, nz: -1, depth: toMinZ + c.r };
  return { nx: 0, nz: 1, depth: toMaxZ + c.r };
}

/** Circle vs OBB: transform into OBB-local space and reuse circleVsAABB. */
export function circleVsOBB(c: Circle, o: OBB): MTV | null {
  const s = Math.sin(o.heading);
  const co = Math.cos(o.heading);
  const dx = c.x - o.x;
  const dz = c.z - o.z;
  // local right = (-co, s), local forward = (s, co)
  const lx = -dx * co + dz * s;
  const lz = dx * s + dz * co;
  const m = circleVsAABB({ x: lx, z: lz, r: c.r }, { minX: -o.halfW, maxX: o.halfW, minZ: -o.halfL, maxZ: o.halfL });
  if (!m) return null;
  // map the local normal back to world: world = right * nx + forward * nz
  return { nx: -m.nx * co + m.nz * s, nz: m.nx * s + m.nz * co, depth: m.depth };
}

/**
 * OBB vs OBB via the separating axis theorem (4 axes). Returns the MTV that moves `a` out
 * of `b`, or null.
 */
export function obbVsOBB(a: OBB, b: OBB): MTV | null {
  const axes: [number, number][] = [
    [-Math.cos(a.heading), Math.sin(a.heading)],
    [Math.sin(a.heading), Math.cos(a.heading)],
    [-Math.cos(b.heading), Math.sin(b.heading)],
    [Math.sin(b.heading), Math.cos(b.heading)],
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let best = Infinity;
  let bnx = 0;
  let bnz = 0;
  for (const [ax, az] of axes) {
    const ra = projectRadius(a, ax, az);
    const rb = projectRadius(b, ax, az);
    const dist = dx * ax + dz * az;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= SAT_EPSILON) return null;
    if (overlap < best) {
      best = overlap;
      // normal must point from b toward a
      const sign = dist > 0 ? -1 : 1;
      bnx = ax * sign;
      bnz = az * sign;
    }
  }
  return { nx: bnx, nz: bnz, depth: best };
}

export function obbVsAABB(a: OBB, b: AABB): MTV | null {
  return obbVsOBB(a, aabbToOBB(b));
}

function projectRadius(o: OBB, ax: number, az: number): number {
  const rx = -Math.cos(o.heading);
  const rz = Math.sin(o.heading);
  const fx = Math.sin(o.heading);
  const fz = Math.cos(o.heading);
  return Math.abs((rx * ax + rz * az) * o.halfW) + Math.abs((fx * ax + fz * az) * o.halfL);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Uniform grid spatial hash for static AABBs (buildings, props). */
export class StaticColliderGrid {
  private readonly cells = new Map<string, (AABB & { id: number })[]>();
  private readonly all: (AABB & { id: number })[] = [];

  constructor(readonly cellSize = 32) {}

  insert(box: AABB & { id: number }): void {
    this.all.push(box);
    const [x0, z0, x1, z1] = this.cellRange(box);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = `${cx},${cz}`;
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(box);
      }
    }
  }

  get count(): number {
    return this.all.length;
  }

  /** Candidate boxes whose cells intersect `query`. Results are deduplicated. */
  query(query: AABB, out: (AABB & { id: number })[] = []): (AABB & { id: number })[] {
    out.length = 0;
    const [x0, z0, x1, z1] = this.cellRange(query);
    const seen = new Set<number>();
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const b of list) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          if (aabbOverlap(query, b)) out.push(b);
        }
      }
    }
    return out;
  }

  private cellRange(b: AABB): [number, number, number, number] {
    const s = this.cellSize;
    return [Math.floor(b.minX / s), Math.floor(b.minZ / s), Math.floor(b.maxX / s), Math.floor(b.maxZ / s)];
  }
}
