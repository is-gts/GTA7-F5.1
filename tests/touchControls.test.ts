import { describe, expect, it } from 'vitest';
import { joystickAxes } from '../src/ui/TouchControls';

describe('joystickAxes (touch joystick -> input axis mapping)', () => {
  it('is zero at the centre and within the deadzone radius', () => {
    expect(joystickAxes(0, 0, 55, 0.12)).toEqual({ x: 0, y: 0 });
    const v = joystickAxes(3, 2, 55, 0.12); // |3,2| / 55 ≈ 0.065 < 0.12 deadzone
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('reaches exactly unit length once the drag reaches maxRadius, straight along one axis', () => {
    const right = joystickAxes(55, 0, 55, 0.12);
    expect(right.x).toBeCloseTo(1, 5);
    expect(right.y).toBeCloseTo(0, 5);
    const down = joystickAxes(0, 55, 55, 0.12);
    expect(down.x).toBeCloseTo(0, 5);
    expect(down.y).toBeCloseTo(1, 5);
    const left = joystickAxes(-55, 0, 55, 0.12);
    expect(left.x).toBeCloseTo(-1, 5);
  });

  it('clamps beyond maxRadius (a finger dragged off the visual knob) to unit length, same direction', () => {
    const v = joystickAxes(200, 0, 55, 0.12);
    expect(v.x).toBeCloseTo(1, 5);
    expect(v.y).toBeCloseTo(0, 5);
  });

  it('rescales the post-deadzone travel so it still reaches 1 at maxRadius, not deadzone-short', () => {
    // Just past the deadzone edge should be just above zero, not a big jump.
    const dz = 0.12;
    const justPast = joystickAxes((dz + 0.01) * 55, 0, 55, dz);
    expect(justPast.x).toBeGreaterThan(0);
    expect(justPast.x).toBeLessThan(0.05);
    // Halfway between the deadzone edge and the max radius should read as ~0.5, not ~0.44
    // (which is what an un-rescaled `(mag - dz)` would give).
    const halfway = joystickAxes(((dz + 1) / 2) * 55, 0, 55, dz);
    expect(halfway.x).toBeCloseTo(0.5, 2);
  });

  it('preserves direction for diagonal drags and keeps the vector normalized at full deflection', () => {
    const v = joystickAxes(55, 55, 55, 0.12); // 45 degrees, magnitude 55*sqrt(2) > maxRadius
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 5);
    expect(v.x).toBeCloseTo(v.y, 5);
    expect(v.x).toBeGreaterThan(0);
  });

  it('is degenerate-safe for a non-positive radius', () => {
    expect(joystickAxes(10, 10, 0, 0.1)).toEqual({ x: 0, y: 0 });
    expect(joystickAxes(10, 10, -5, 0.1)).toEqual({ x: 0, y: 0 });
  });

  it('clamps an out-of-range deadzone fraction into [0, 0.95]', () => {
    // A deadzone of 2 would otherwise make everything (including maxRadius itself) zero.
    const v = joystickAxes(55, 0, 55, 2);
    expect(v.x).toBeGreaterThan(0);
  });
});
