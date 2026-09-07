/**
 * Pure, renderer-agnostic helpers for the screen-space reflection ray-march (see `SSRPass.ts`),
 * kept separate so the marching/refinement logic and the Fresnel term can be unit-tested without a
 * WebGL context — the same idea as `TAAJitter.ts` for the TAA pass. `SSRPass.ts`'s GLSL mirrors this
 * algorithm (fixed step count, then a fixed number of binary-search refinement steps) exactly.
 */

export interface SSRRayResult {
  hit: boolean;
  /** Screen UV (0..1) of the hit (or the last sample tried, when `hit` is false). */
  u: number;
  v: number;
  /** Fraction of the max step budget consumed (0..1) — used to fade reflections near the ray's
   *  maximum travel distance. */
  t: number;
}

/**
 * Marches a ray through screen-UV + linear-depth space, one fixed step at a time from
 * `(u0,v0,z0)` along per-step deltas `(du,dv,dz)`, calling `sceneDepthAt(u,v)` — the depth actually
 * stored in the G-buffer, linear/camera-relative, larger = farther away, `Infinity`/`NaN` for
 * sky/nothing rendered — at each sample. A hit is declared once the ray's own depth has gone
 * *behind* the stored scene depth by more than `bias` (it's now inside/behind geometry) but by less
 * than `thickness` (reject marching straight through a thin surface into whatever is behind it,
 * which would otherwise read as a false "hit" on the wrong object). Once a hit step is found, it is
 * refined by `binarySteps` of bisection against the previous (miss) sample for a tighter UV.
 *
 * Returns `{ hit: false }` as soon as the ray leaves the `[0,1]` UV box, or after `steps` samples
 * with no hit.
 */
export function raymarchSSR(
  u0: number,
  v0: number,
  z0: number,
  du: number,
  dv: number,
  dz: number,
  steps: number,
  sceneDepthAt: (u: number, v: number) => number,
  thickness: number,
  binarySteps = 5,
  bias = 0.01,
): SSRRayResult {
  const n = Math.max(1, Math.floor(steps));
  let u = u0;
  let v = v0;
  let z = z0;
  let prevU = u0;
  let prevV = v0;
  let prevZ = z0;
  for (let i = 1; i <= n; i++) {
    u = u0 + du * i;
    v = v0 + dv * i;
    z = z0 + dz * i;
    if (u < 0 || u > 1 || v < 0 || v > 1) return { hit: false, u, v, t: i / n };
    const sceneZ = sceneDepthAt(u, v);
    if (Number.isFinite(sceneZ) && z > sceneZ + bias && z - sceneZ < thickness) {
      let loU = prevU, loV = prevV, loZ = prevZ; // last known miss (in front of / at the surface)
      let hiU = u, hiV = v, hiZ = z; // known hit (behind the surface)
      for (let b = 0; b < binarySteps; b++) {
        const mu = (loU + hiU) / 2;
        const mv = (loV + hiV) / 2;
        const mz = (loZ + hiZ) / 2;
        const mSceneZ = sceneDepthAt(mu, mv);
        if (Number.isFinite(mSceneZ) && mz > mSceneZ + bias) {
          hiU = mu; hiV = mv; hiZ = mz;
        } else {
          loU = mu; loV = mv; loZ = mz;
        }
      }
      return { hit: true, u: hiU, v: hiV, t: i / n };
    }
    prevU = u; prevV = v; prevZ = z;
  }
  return { hit: false, u, v, t: 1 };
}

/**
 * Schlick's Fresnel approximation: reflectance at grazing angle vs. normal incidence. `f0` is the
 * normal-incidence reflectance (0..1, e.g. ~0.02 for wet asphalt); `cosTheta` is the cosine between
 * the surface normal and the view direction, clamped to `[0,1]`.
 */
export function fresnelSchlick(cosTheta: number, f0: number): number {
  const c = cosTheta < 0 ? 0 : cosTheta > 1 ? 1 : cosTheta;
  return f0 + (1 - f0) * Math.pow(1 - c, 5);
}
