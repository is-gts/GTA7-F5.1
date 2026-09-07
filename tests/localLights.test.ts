import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { getPreset } from '../src/core/Quality';
import { LocalLights, selectNearestLamps, type LampPoint } from '../src/render/LocalLights';

function grid(n: number, spacing = 10): LampPoint[] {
  const lamps: LampPoint[] = [];
  for (let i = 0; i < n; i++) lamps.push({ x: i * spacing, y: 6, z: 0 });
  return lamps;
}

describe('selectNearestLamps', () => {
  it('never returns more than maxCount, even with many candidates in range', () => {
    const lamps = grid(50, 2);
    const idx: number[] = [];
    const dsq: number[] = [];
    const n = selectNearestLamps(lamps, 0, 0, 1000, 4, idx, dsq);
    expect(n).toBe(4);
    expect(idx.length).toBe(4);
  });

  it('returns fewer than maxCount when fewer lamps are in range', () => {
    const lamps = grid(3, 5);
    const idx: number[] = [];
    const dsq: number[] = [];
    const n = selectNearestLamps(lamps, 0, 0, 6, 8, idx, dsq);
    // Only lamps at x=0 and x=5 are within 6 m; x=10 is not.
    expect(n).toBe(2);
  });

  it('returns 0 when maxCount is 0 (the low-preset "no real lights" case)', () => {
    const lamps = grid(10);
    const idx: number[] = [];
    const dsq: number[] = [];
    const n = selectNearestLamps(lamps, 0, 0, 1000, 0, idx, dsq);
    expect(n).toBe(0);
    expect(idx.length).toBe(0);
  });

  it('is sorted nearest-first and picks the actual nearest lamps', () => {
    const lamps: LampPoint[] = [
      { x: 100, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 50, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
    ];
    const idx: number[] = [];
    const dsq: number[] = [];
    const n = selectNearestLamps(lamps, 0, 0, 1000, 3, idx, dsq);
    expect(n).toBe(3);
    const picked = idx.map((i) => lamps[i]!.x);
    expect(picked).toEqual([1, 5, 20]);
    // Distances themselves must also be sorted ascending.
    for (let i = 1; i < dsq.length; i++) expect(dsq[i]!).toBeGreaterThanOrEqual(dsq[i - 1]!);
  });

  it('excludes lamps outside maxDistance entirely', () => {
    const lamps = grid(5, 10); // x = 0, 10, 20, 30, 40
    const idx: number[] = [];
    const dsq: number[] = [];
    const n = selectNearestLamps(lamps, 0, 0, 15, 10, idx, dsq);
    expect(n).toBe(2); // x=0 and x=10 only
  });

  it('is stable across repeated calls with a moving focus (never allocates a new array identity)', () => {
    const lamps = grid(20, 3);
    const idx: number[] = [];
    const dsq: number[] = [];
    for (let fx = 0; fx < 50; fx += 1.3) {
      const n = selectNearestLamps(lamps, fx, 0, 60, 4, idx, dsq);
      expect(n).toBeLessThanOrEqual(4);
      expect(idx.length).toBe(n);
      // sorted nearest-first
      for (let i = 1; i < dsq.length; i++) expect(dsq[i]!).toBeGreaterThanOrEqual(dsq[i - 1]!);
    }
  });
});

describe('LocalLights', () => {
  it('sizes its pool to the quality preset (0/4/8/16) and updates on quality change', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('low'));
    expect(pool.lights.length).toBe(0);
    pool.setQuality(getPreset('medium'));
    expect(pool.lights.length).toBe(4);
    pool.setQuality(getPreset('ultra'));
    expect(pool.lights.length).toBe(16);
    pool.setQuality(getPreset('low'));
    expect(pool.lights.length).toBe(0);
  });

  it('lights the nearest lamps at night and reports `active`, never exceeding the pool size', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('medium')); // maxLocalLights = 4
    const lamps = grid(30, 5);
    pool.update(lamps, 25, 0, 1);
    expect(pool.active).toBe(4);
    expect(pool.active).toBeLessThanOrEqual(pool.lights.length);
    // Every pooled light stays `visible = true` forever (see the update() doc comment: toggling
    // `visible` per-frame would change the compiled shader-program count) -- "off" is expressed as
    // `intensity === 0` instead.
    for (const l of pool.lights) expect(l.visible).toBe(true);
    const lit = pool.lights.filter((l) => l.intensity > 0);
    expect(lit.length).toBe(4);
  });

  it('turns everything off during the day (night factor ~0) without resizing the pool or hiding lights', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('high'));
    const lamps = grid(10, 5);
    pool.update(lamps, 0, 0, 0);
    expect(pool.active).toBe(0);
    // "Off" means intensity 0, not visible = false (which would change the visible-light count and
    // force a shader recompile every time it changed -- see LocalLights.update's doc comment).
    for (const l of pool.lights) {
      expect(l.visible).toBe(true);
      expect(l.intensity).toBe(0);
    }
    expect(pool.lights.length).toBe(8);
  });

  it('never lights anything when maxLocalLights is 0 (low preset)', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('low'));
    const lamps = grid(10, 5);
    pool.update(lamps, 0, 0, 1);
    expect(pool.active).toBe(0);
  });

  it('repositions the pool without allocating new PointLight instances', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('high'));
    const lamps = grid(30, 5);
    pool.update(lamps, 0, 0, 1);
    const identities = new Set(pool.lights);
    pool.update(lamps, 40, 0, 1);
    for (const l of identities) expect(pool.lights).toContain(l);
    expect(pool.lights.length).toBe(8);
  });

  it('does not cast shadows (no real lights are shadow casters)', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('ultra'));
    for (const l of pool.lights) expect(l.castShadow).toBe(false);
  });

  it('dispose() removes every light from the scene and empties the pool', () => {
    const scene = new Scene();
    const pool = new LocalLights(scene, getPreset('ultra'));
    expect(scene.children.length).toBe(16);
    pool.dispose();
    expect(scene.children.length).toBe(0);
    expect(pool.lights.length).toBe(0);
  });
});
