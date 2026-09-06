import { describe, expect, it } from 'vitest';
import { segmentVsAABB } from '../src/entities/CameraRig';

const box = { minX: 10, minZ: -5, maxX: 20, maxZ: 5 };

describe('segmentVsAABB', () => {
  it('returns the entry parameter when the segment hits the box', () => {
    const t = segmentVsAABB(0, 0, 30, 0, box, 0);
    expect(t).not.toBeNull();
    // entry at x=10 -> t = 1/3, minus the small back-off
    expect(t!).toBeGreaterThan(0.3);
    expect(t!).toBeLessThan(0.34);
  });

  it('returns null when the segment misses or ends before the box', () => {
    expect(segmentVsAABB(0, 10, 30, 10, box, 0)).toBeNull();
    expect(segmentVsAABB(0, 0, 5, 0, box, 0)).toBeNull();
  });

  it('respects padding and ignores segments starting inside', () => {
    expect(segmentVsAABB(0, 6, 30, 6, box, 0)).toBeNull();
    expect(segmentVsAABB(0, 6, 30, 6, box, 2)).not.toBeNull();
    expect(segmentVsAABB(15, 0, 30, 0, box, 0)).toBeNull();
  });
});
