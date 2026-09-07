import { describe, expect, it } from 'vitest';
import { Debounced } from '../src/core/Debounced';

describe('Debounced', () => {
  it('does not fire until the quiet period has elapsed since the last push', () => {
    const d = new Debounced<number>(0.3);
    d.push(1);
    expect(d.tick(0.1)).toBeNull();
    expect(d.tick(0.1)).toBeNull();
    expect(d.isPending).toBe(true);
    expect(d.tick(0.2)).toBe(1); // 0.1+0.1+0.2 = 0.4 >= 0.3
    expect(d.isPending).toBe(false);
  });

  it('a fresh push resets the quiet-time clock, so continuous dragging never fires', () => {
    const d = new Debounced<number>(0.3);
    d.push(1);
    expect(d.tick(0.2)).toBeNull();
    d.push(2); // resets elapsed back to 0
    expect(d.tick(0.2)).toBeNull(); // only 0.2s of quiet time since the last push
    expect(d.tick(0.2)).toBe(2); // now 0.4s of quiet time: fires with the latest value
  });

  it('merges consecutive pushes via the optional merge function', () => {
    const d = new Debounced<Record<string, number>>(0.3);
    d.push({ a: 1 }, (prev, next) => ({ ...prev, ...next }));
    d.push({ b: 2 }, (prev, next) => ({ ...prev, ...next }));
    d.push({ a: 3 }, (prev, next) => ({ ...prev, ...next }));
    expect(d.peek()).toEqual({ a: 3, b: 2 });
    expect(d.tick(0.3)).toEqual({ a: 3, b: 2 });
  });

  it('without a merge function, a later push replaces the pending value outright', () => {
    const d = new Debounced<number>(0.3);
    d.push(1);
    d.push(2);
    expect(d.peek()).toBe(2);
  });

  it('flush returns and clears the pending value immediately, skipping the remaining quiet time', () => {
    const d = new Debounced<number>(5);
    d.push(42);
    expect(d.flush()).toBe(42);
    expect(d.isPending).toBe(false);
    expect(d.flush()).toBeNull();
  });

  it('cancel discards the pending value without returning it', () => {
    const d = new Debounced<number>(0.1);
    d.push(1);
    d.cancel();
    expect(d.isPending).toBe(false);
    expect(d.tick(1)).toBeNull();
  });

  it('tick and flush are no-ops when nothing is pending', () => {
    const d = new Debounced<number>(0.1);
    expect(d.tick(10)).toBeNull();
    expect(d.flush()).toBeNull();
    expect(d.peek()).toBeNull();
  });

  it('negative dt does not un-elapse time (clamped to 0)', () => {
    const d = new Debounced<number>(0.2);
    d.push(1);
    expect(d.tick(0.15)).toBeNull();
    expect(d.tick(-5)).toBeNull(); // clamped to 0, does not reduce elapsed
    expect(d.tick(0.05)).toBe(1); // 0.15 + 0 + 0.05 = 0.2
  });
});
