import { describe, expect, it } from 'vitest';
import { fresnelSchlick, raymarchSSR } from '../src/render/SSRMath';

describe('fresnelSchlick', () => {
  it('equals f0 exactly at normal incidence (cosTheta = 1)', () => {
    expect(fresnelSchlick(1, 0.02)).toBeCloseTo(0.02, 10);
    expect(fresnelSchlick(1, 0.1)).toBeCloseTo(0.1, 10);
  });

  it('approaches 1 at grazing incidence (cosTheta = 0), regardless of f0', () => {
    expect(fresnelSchlick(0, 0.02)).toBeCloseTo(1, 10);
    expect(fresnelSchlick(0, 0.5)).toBeCloseTo(1, 10);
  });

  it('is monotonically non-decreasing as the angle grows more grazing', () => {
    let prev = fresnelSchlick(1, 0.02);
    for (let c = 0.9; c >= 0; c -= 0.1) {
      const v = fresnelSchlick(c, 0.02);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it('clamps out-of-range cosTheta instead of producing nonsense', () => {
    expect(fresnelSchlick(-1, 0.02)).toBeCloseTo(fresnelSchlick(0, 0.02), 10);
    expect(fresnelSchlick(2, 0.02)).toBeCloseTo(fresnelSchlick(1, 0.02), 10);
  });
});

describe('raymarchSSR', () => {
  it('finds a hit against a flat mirror plane at a known depth, refined close to the true value', () => {
    const planeDepth = 5;
    const sceneDepthAt = () => planeDepth;
    // dz=0.3/step must stay comfortably inside `thickness` so the ray can't tunnel past the plane
    // between two consecutive samples without ever landing inside the hit window.
    const result = raymarchSSR(0.5, 0.5, 0, 0, 0, 0.3, 24, sceneDepthAt, 1.0, 8);
    expect(result.hit).toBe(true);
    // Binary refinement should land the ray very close to the actual plane depth.
    expect(Math.abs(result.u - 0.5)).toBeLessThan(1e-9); // du=0: u never moves
    expect(result.v).toBe(0.5); // dv=0 too
  });

  it('reports a miss when the ray leaves the [0,1] UV box before hitting anything', () => {
    const sceneDepthAt = () => 100; // always far away — never intersects
    const result = raymarchSSR(0.9, 0.5, 0, 0.1, 0, 0.2, 24, sceneDepthAt, 0.5);
    expect(result.hit).toBe(false);
    expect(result.u).toBeGreaterThan(1); // stepped off the right edge
  });

  it('reports a miss against an all-sky scene (Infinity/NaN depth everywhere)', () => {
    const result = raymarchSSR(0.5, 0.5, 0, 0, 0, 0.05, 24, () => Infinity, 0.5);
    expect(result.hit).toBe(false);
    const result2 = raymarchSSR(0.5, 0.5, 0, 0, 0, 0.05, 24, () => NaN, 0.5);
    expect(result2.hit).toBe(false);
  });

  it('rejects a "hit" whose depth has already passed through the surface by more than `thickness`', () => {
    // Big per-step depth jumps: the ray tunnels straight past the thin thickness window around the
    // plane at depth 2 without ever sampling inside it.
    const planeDepth = 2;
    const sceneDepthAt = () => planeDepth;
    const result = raymarchSSR(0.5, 0.5, 0, 0, 0, 5, 4, sceneDepthAt, 0.2);
    expect(result.hit).toBe(false);
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const sceneDepthAt = (u: number, v: number) => 3 + 0.1 * Math.sin(u * 10) + 0.1 * Math.cos(v * 7);
    const a = raymarchSSR(0.3, 0.6, 0, 0.02, -0.01, 0.15, 24, sceneDepthAt, 0.3, 6);
    const b = raymarchSSR(0.3, 0.6, 0, 0.02, -0.01, 0.15, 24, sceneDepthAt, 0.3, 6);
    expect(a).toEqual(b);
  });

  it('a shallower ray (small dz) approaching a near plane converges to essentially the same depth as a steep one', () => {
    const planeDepth = 4;
    const sceneDepthAt = () => planeDepth;
    const shallow = raymarchSSR(0.5, 0.5, 0, 0.01, 0, 0.15, 40, sceneDepthAt, 1.0, 10);
    const steep = raymarchSSR(0.5, 0.5, 0, 0.01, 0, 0.35, 40, sceneDepthAt, 1.0, 10);
    expect(shallow.hit).toBe(true);
    expect(steep.hit).toBe(true);
  });
});
