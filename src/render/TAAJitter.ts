/**
 * Pure, WebGL-free math for TAA's per-frame sub-pixel camera jitter — kept separate from
 * `TAAPass.ts` so it can be unit-tested without a renderer (see `tests/taa.test.ts`).
 */

/** Number of samples the TAA jitter cycles through before repeating (Halton(2,3), see task doc). */
export const TAA_SAMPLE_COUNT = 8;

/**
 * The `index`-th value (1-based) of the van der Corput / Halton sequence in the given `base`.
 * Deterministic, in `[0, 1)`. `index` must be >= 1 (index 0 would yield the degenerate value 0,
 * which is why samples are always drawn starting at index 1 — see `buildJitterOffset`).
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = Math.floor(index);
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/** The Halton(2,3) sequence as 2D points in `[0,1)²`, `count` entries (1-based Halton index). */
export function haltonSequence2D(count: number): { x: number; y: number }[] {
  const seq: { x: number; y: number }[] = [];
  for (let i = 1; i <= count; i++) seq.push({ x: halton(i, 2), y: halton(i, 3) });
  return seq;
}

/**
 * The projection-matrix jitter offset for sample `sampleIndex` (0-based, wraps at `sampleCount`)
 * of a `width`×`height` (pixel) render target — a Halton(2,3) sample centred on the pixel and
 * scaled to NDC units (NDC spans 2 units across `width`/`height` pixels, so a full-pixel step in x
 * is `2/width`).
 *
 * The caller applies this as `projectionMatrix.elements[8] -= x; elements[9] -= y;` immediately
 * before rendering, then restores the original elements right after — this is algebraically
 * equivalent to post-multiplying the projection by a small clip-space translation (`T·P`), which
 * yields a constant NDC-space offset independent of depth (unlike jittering elements[12]/[13],
 * whose effect is divided by `w` and varies with distance).
 */
export function buildJitterOffset(sampleIndex: number, sampleCount: number, width: number, height: number): { x: number; y: number } {
  const count = Math.max(1, Math.floor(sampleCount));
  const i = (((Math.floor(sampleIndex) % count) + count) % count) + 1; // 1-based Halton index
  const hx = halton(i, 2);
  const hy = halton(i, 3);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return { x: ((hx - 0.5) * 2) / w, y: ((hy - 0.5) * 2) / h };
}
