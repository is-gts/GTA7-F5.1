/**
 * Dynamic street lighting: a small fixed-size pool of `PointLight`s that always tracks the N lamp
 * heads nearest the player/vehicle (N = `QualitySettings.maxLocalLights`; 0 on low, which instead
 * gets the ground-decal "light pool" built into `CityBuilder`). The pool is sized once per quality
 * preset and `update()` only ever repositions existing lights — it never allocates one.
 */
import { Color, PointLight, type Scene } from 'three';
import type { QualitySettings } from '../core/Quality';

export interface LampPoint {
  x: number;
  y: number;
  z: number;
}

/** Warm streetlamp colour (matches the emissive lamp-head material in `CityBuilder`). */
const LAMP_COLOR = new Color(0xffcf8a).getHex();
/** Falloff distance (m) of a single street lamp's light pool. */
export const LOCAL_LIGHT_DISTANCE = 18;
/** How far from the focus point (player/vehicle) a lamp still counts as "nearby" (m). */
export const LOCAL_LIGHT_SEARCH_RADIUS = 60;
/**
 * Point-light intensity (candela, decay=2) at full night; scaled by the night factor below that.
 * Lamp heads sit ~6 m above the ground, so the irradiance directly under one is `BASE_INTENSITY /
 * 36` — at 60 that is ~1.7, a clearly visible warm pool on the sidewalk without threatening the
 * ~64 HDR cap even at the fixture itself. (A much lower value here is effectively invisible: at 9
 * it was only a ~10% lift over the already near-black night ground, i.e. no pool at all.)
 */
const BASE_INTENSITY = 60;

/**
 * Selects (by index into `lamps`) the `maxCount` points nearest to `(fx, fz)` within `maxDistance`,
 * nearest first, and writes them into the caller-owned `outIndices`/`outDistSq` scratch arrays (so
 * repeat calls allocate nothing). Returns how many were found: always `<= maxCount` and
 * `<= lamps.length`, and stable — equidistant candidates keep their original relative order.
 *
 * A small bounded insertion sort (the output is capped at `maxCount`, typically <= 16) keeps this
 * O(lamps.length * maxCount) with no heap allocation, which is what makes it safe to call once a
 * tick from `Game.update`/`render` without a per-frame GC cost.
 */
export function selectNearestLamps(
  lamps: readonly LampPoint[],
  fx: number,
  fz: number,
  maxDistance: number,
  maxCount: number,
  outIndices: number[],
  outDistSq: number[],
): number {
  outIndices.length = 0;
  outDistSq.length = 0;
  if (maxCount <= 0) return 0;
  const maxDistSq = maxDistance * maxDistance;
  for (let i = 0; i < lamps.length; i++) {
    const l = lamps[i]!;
    const dx = l.x - fx;
    const dz = l.z - fz;
    const dsq = dx * dx + dz * dz;
    if (dsq > maxDistSq) continue;
    if (outIndices.length < maxCount) {
      let pos = outIndices.length;
      outIndices.push(i);
      outDistSq.push(dsq);
      while (pos > 0 && outDistSq[pos - 1]! > outDistSq[pos]!) {
        swap(outDistSq, outIndices, pos - 1, pos);
        pos--;
      }
    } else if (dsq < outDistSq[maxCount - 1]!) {
      let pos = maxCount - 1;
      outDistSq[pos] = dsq;
      outIndices[pos] = i;
      while (pos > 0 && outDistSq[pos - 1]! > outDistSq[pos]!) {
        swap(outDistSq, outIndices, pos - 1, pos);
        pos--;
      }
    }
  }
  return outIndices.length;
}

function swap(dist: number[], idx: number[], a: number, b: number): void {
  const d = dist[a]!;
  dist[a] = dist[b]!;
  dist[b] = d;
  const i = idx[a]!;
  idx[a] = idx[b]!;
  idx[b] = i;
}

export class LocalLights {
  readonly lights: PointLight[] = [];
  /** Number of lights actually lit by the last `update()` call (<= pool size). */
  active = 0;
  private maxCount = 0;
  private readonly outIndices: number[] = [];
  private readonly outDistSq: number[] = [];

  constructor(private readonly scene: Scene, quality: QualitySettings) {
    this.setQuality(quality);
  }

  /**
   * Resize the pool to `quality.maxLocalLights`, adding/removing `PointLight`s as needed. Newly
   * created lights stay `visible = true` forever — see `update()` for why toggling `visible`
   * per-frame must never happen once a light exists.
   */
  setQuality(q: QualitySettings): void {
    const n = Math.max(0, Math.floor(q.maxLocalLights));
    while (this.lights.length < n) {
      const l = new PointLight(LAMP_COLOR, 0, LOCAL_LIGHT_DISTANCE, 2);
      l.castShadow = false;
      l.visible = true;
      this.scene.add(l);
      this.lights.push(l);
    }
    while (this.lights.length > n) {
      const l = this.lights.pop()!;
      l.removeFromParent();
    }
    this.maxCount = n;
    if (n === 0) this.active = 0;
  }

  /**
   * Reposition the pool onto the lamps nearest `(fx, fz)`; intensity scales with `night` (0..1).
   * Unused slots (and the whole pool by day) are turned off by setting `intensity = 0`, never by
   * `visible = false`: three.js keys shader program compilation on the number of *visible* lights
   * of each type in the scene, so toggling `visible` as the active count changes would force a new
   * shader variant compile on every lit material each time a different count is seen (a multi-
   * hundred-ms hitch at dusk/dawn and every time a lamp drops in or out of range while driving).
   * Keeping every pooled light permanently visible and driving it through `intensity` alone keeps
   * the visible-light count — and therefore the compiled program count — fixed per quality preset.
   */
  update(lamps: readonly LampPoint[], fx: number, fz: number, night: number): void {
    if (this.maxCount === 0 || night <= 0.02) {
      this.active = 0;
      for (const l of this.lights) l.intensity = 0;
      return;
    }
    const count = selectNearestLamps(lamps, fx, fz, LOCAL_LIGHT_SEARCH_RADIUS, this.maxCount, this.outIndices, this.outDistSq);
    this.active = count;
    const intensity = BASE_INTENSITY * Math.max(0, Math.min(1, night));
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]!;
      if (i < count) {
        const lamp = lamps[this.outIndices[i]!]!;
        light.position.set(lamp.x, lamp.y, lamp.z);
        light.intensity = intensity;
      } else {
        light.intensity = 0;
      }
    }
  }

  dispose(): void {
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    this.maxCount = 0;
    this.active = 0;
  }
}
