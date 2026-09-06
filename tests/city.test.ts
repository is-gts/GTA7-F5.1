import { describe, expect, it } from 'vitest';
import { Random, hashString, valueNoise2D } from '../src/world/Random';
import {
  DEFAULT_CITY_PARAMS,
  blockPitch,
  buildingAABBs,
  generateCity,
  gridLine,
  laneOffsets,
  lanePoint,
} from '../src/world/CityGenerator';
import { aabbOverlap } from '../src/physics/Collision';

describe('Random', () => {
  it('is deterministic per seed and uniform-ish', () => {
    const a = new Random(42);
    const b = new Random(42);
    const seq = Array.from({ length: 5 }, () => a.next());
    expect(seq).toEqual(Array.from({ length: 5 }, () => b.next()));
    const c = new Random(43);
    expect(c.next()).not.toBe(seq[0]);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += a.next();
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
    for (let i = 0; i < 1000; i++) {
      const v = a.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(valueNoise2D(1.5, 2.5, 1)).toBeGreaterThanOrEqual(0);
    expect(valueNoise2D(1.5, 2.5, 1)).toBeLessThan(1);
    expect(valueNoise2D(1.5, 2.5, 1)).toBe(valueNoise2D(1.5, 2.5, 1));
  });

  it('fork is independent of the parent sequence', () => {
    const a = new Random(1);
    const f1 = a.fork('x').next();
    a.next();
    const a2 = new Random(1);
    expect(a2.fork('x').next()).toBe(f1);
  });
});

describe('generateCity', () => {
  const city = generateCity({ seed: 7, cols: 6, rows: 5 });

  it('is deterministic for a seed', () => {
    const again = generateCity({ seed: 7, cols: 6, rows: 5 });
    expect(again.buildings.length).toBe(city.buildings.length);
    expect(again.buildings.map((b) => [b.x, b.z, b.h])).toEqual(city.buildings.map((b) => [b.x, b.z, b.h]));
    const other = generateCity({ seed: 8, cols: 6, rows: 5 });
    expect(other.buildings.map((b) => b.h)).not.toEqual(city.buildings.map((b) => b.h));
  });

  it('builds a grid road graph with correct node/edge counts', () => {
    const { nodes, edges, adjacency } = city.roads;
    expect(nodes.length).toBe(7 * 6);
    expect(edges.length).toBe(6 * 6 + 7 * 5);
    for (const n of nodes) {
      const deg = adjacency[n.id]!.length;
      expect(deg).toBeGreaterThanOrEqual(2);
      expect(deg).toBeLessThanOrEqual(4);
    }
    for (const e of edges) expect(e.length).toBeCloseTo(blockPitch(city.params));
  });

  it('keeps every building inside its block and off the roads', () => {
    const p = city.params;
    expect(city.buildings.length).toBeGreaterThan(0);
    for (const block of city.blocks) {
      for (const b of block.buildings) {
        expect(b.x - b.w / 2).toBeGreaterThanOrEqual(block.x0 + p.sidewalkWidth - 1e-9);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(block.x0 + block.size - p.sidewalkWidth + 1e-9);
        expect(b.z - b.d / 2).toBeGreaterThanOrEqual(block.z0 + p.sidewalkWidth - 1e-9);
        expect(b.z + b.d / 2).toBeLessThanOrEqual(block.z0 + block.size - p.sidewalkWidth + 1e-9);
        expect(b.h).toBeGreaterThan(0);
      }
    }
  });

  it('has no overlapping building footprints', () => {
    const boxes = buildingAABBs(city);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(aabbOverlap(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it('spawns on a road lane, not inside a building', () => {
    const boxes = buildingAABBs(city);
    const s = city.spawn;
    for (const b of boxes) {
      expect(s.x >= b.minX && s.x <= b.maxX && s.z >= b.minZ && s.z <= b.maxZ).toBe(false);
    }
    // Spawn lies within roadWidth/2 of a horizontal road centreline.
    const j = Math.floor(city.params.rows / 2);
    expect(Math.abs(s.z - gridLine(city.params, j, 'z'))).toBeLessThan(city.params.roadWidth / 2);
  });

  it('lanePoint offsets to the right of travel and flips with direction', () => {
    const e = city.roads.edges.find((ed) => ed.axis === 'x')!;
    const fwd = lanePoint(city, e, 0.5, true, 0);
    const back = lanePoint(city, e, 0.5, false, 0);
    const na = city.roads.nodes[e.a]!;
    const off = laneOffsets(city.params)[0]!;
    // travelling +X: right is +Z  -> z = centreline + off
    expect(fwd.z).toBeCloseTo(na.z + off);
    expect(back.z).toBeCloseTo(na.z - off);
    expect(fwd.heading).toBeCloseTo(Math.PI / 2);
    expect(back.heading).toBeCloseTo(-Math.PI / 2);
    expect(laneOffsets(DEFAULT_CITY_PARAMS).length).toBe(2);
  });

  it('assigns chunk keys and chunk bounds cover all buildings', () => {
    expect(city.chunks.length).toBe(Math.ceil(6 / 2) * Math.ceil(5 / 2));
    const byKey = new Map(city.chunks.map((c) => [c.key, c]));
    for (const b of city.buildings) {
      const c = byKey.get(b.chunkKey)!;
      expect(c).toBeDefined();
      expect(b.x).toBeGreaterThan(c.bounds.minX);
      expect(b.x).toBeLessThan(c.bounds.maxX);
    }
    expect(city.lamps.length).toBeGreaterThan(0);
  });

  it('rejects invalid params', () => {
    expect(() => generateCity({ cols: 0 })).toThrow();
    expect(() => generateCity({ roadWidth: 2 })).toThrow();
  });
});
