import { describe, expect, it } from 'vitest';
import { buildJitterOffset, halton, haltonSequence2D, TAA_SAMPLE_COUNT } from '../src/render/TAAJitter';

describe('halton', () => {
  it('produces the exact first 8 values of the base-2 (van der Corput) sequence', () => {
    const expected = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875, 0.0625];
    for (let i = 1; i <= 8; i++) expect(halton(i, 2)).toBeCloseTo(expected[i - 1]!, 12);
  });

  it('produces the exact first 8 values of the base-3 sequence', () => {
    const expected = [1 / 3, 2 / 3, 1 / 9, 4 / 9, 7 / 9, 2 / 9, 5 / 9, 8 / 9];
    for (let i = 1; i <= 8; i++) expect(halton(i, 3)).toBeCloseTo(expected[i - 1]!, 12);
  });

  it('always stays in [0, 1)', () => {
    for (let i = 1; i <= 200; i++) {
      for (const base of [2, 3, 5]) {
        const v = halton(i, base);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});

describe('haltonSequence2D', () => {
  it('pairs the base-2 and base-3 sequences, matching halton() pointwise', () => {
    const seq = haltonSequence2D(8);
    expect(seq).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(seq[i]!.x).toBeCloseTo(halton(i + 1, 2), 12);
      expect(seq[i]!.y).toBeCloseTo(halton(i + 1, 3), 12);
    }
  });
});

describe('buildJitterOffset', () => {
  it('matches the Halton(2,3) formula scaled to NDC pixel units', () => {
    const width = 1000;
    const height = 800;
    for (let i = 0; i < TAA_SAMPLE_COUNT; i++) {
      const { x, y } = buildJitterOffset(i, TAA_SAMPLE_COUNT, width, height);
      const hx = halton(i + 1, 2);
      const hy = halton(i + 1, 3);
      expect(x).toBeCloseTo(((hx - 0.5) * 2) / width, 12);
      expect(y).toBeCloseTo(((hy - 0.5) * 2) / height, 12);
    }
  });

  it('stays within one pixel of NDC extent in both axes', () => {
    const width = 1920;
    const height = 1080;
    for (let i = 0; i < 16; i++) {
      const { x, y } = buildJitterOffset(i, 8, width, height);
      expect(Math.abs(x)).toBeLessThan(2 / width);
      expect(Math.abs(y)).toBeLessThan(2 / height);
    }
  });

  it('wraps the sample index modulo sampleCount', () => {
    const a = buildJitterOffset(0, 8, 640, 480);
    const b = buildJitterOffset(8, 8, 640, 480);
    const c = buildJitterOffset(16, 8, 640, 480);
    expect(b.x).toBeCloseTo(a.x, 12);
    expect(b.y).toBeCloseTo(a.y, 12);
    expect(c.x).toBeCloseTo(a.x, 12);
    expect(c.y).toBeCloseTo(a.y, 12);
  });

  it('is deterministic and depends only on its inputs', () => {
    const a = buildJitterOffset(3, 8, 800, 600);
    const b = buildJitterOffset(3, 8, 800, 600);
    expect(a).toEqual(b);
  });

  it('produces a different offset for every sample in the cycle (no accidental collisions)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < TAA_SAMPLE_COUNT; i++) {
      const { x, y } = buildJitterOffset(i, TAA_SAMPLE_COUNT, 1024, 768);
      seen.add(`${x.toFixed(9)},${y.toFixed(9)}`);
    }
    expect(seen.size).toBe(TAA_SAMPLE_COUNT);
  });
});
